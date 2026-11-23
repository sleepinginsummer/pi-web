import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync, writePrivateFileCreateAtomicSync } from "./atomic-file";

/**
 * 顶栏“补充提示词”。全局文件只保存新会话的默认内容；会话开始（首条消息，或第一次在
 * 该会话里操作）时复制一份到自己的快照文件，此后开关和内容都只读写这份快照，
 * 改全局或别的会话都影响不到它，修改某个会话也不会反过来覆写全局默认内容。快照默认关闭，不写会话 JSONL，没有存活 wrapper 的
 * 历史会话也能操作。这个文件只管界面读写，实际注入在独立扩展 pi-system-prompt-addon，
 * 磁盘格式两边共用，改格式要一起改。
 */

export const SYSTEM_PROMPT_ADDON_MAX_LENGTH = 100_000;

export interface SessionSystemPromptAddon {
  enabled: boolean;
  text: string;
}

export interface SessionSystemPromptAddonRecord extends SessionSystemPromptAddon {
  /** 团队自动写入或迁入的职责片段；更新职责或移出团队时只替换/移除该片段，保留用户自定义文本。 */
  teamRoleText?: string;
  /** 自动写入或迁入的职责片段在正文中的起始偏移，用于编辑前后核对原片段归属。 */
  teamRoleOffset?: number;
  /** 标记由团队角色初始化且未被用户改写正文，移出团队或解散团队时可自动清理。 */
  teamManaged?: boolean;
  /** 标记旧团队成员职责已处理过迁移，避免用户后续关闭或清空后被重复回填。 */
  teamRoleMigrated?: boolean;
  /** 标记该快照由全局默认自动复制且正文未经用户编辑，供旧团队成员迁移时区分未编辑默认副本与停用草稿。 */
  fromDefault?: boolean;
}

export interface TeamRoleAddonResolution {
  /** "snapshot": 职责已合入快照；"separate": 保留原快照不动，职责由团队扩展临时追加（如停用草稿或合并超限）。 */
  mode: "snapshot" | "separate";
  addon: SessionSystemPromptAddon | null;
  separateRoleText?: string;
}

function defaultPath(agentDir: string): string {
  return join(agentDir, "pi-web-system-prompt-addon.json");
}

function sessionPath(sessionId: string, agentDir: string): string {
  // 会话 id 来自请求，拼路径前必须挡住分隔符和 “..”。
  if (!/^[\w-]+$/.test(sessionId)) throw new RangeError("Invalid sessionId");
  return join(agentDir, "pi-web-system-prompt-addon-sessions", `${sessionId}.json`);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 严格读取 JSON 对象：仅 ENOENT 视为不存在，其余读取或解析错误向上抛出供事务中止回滚。 */
function readJsonObjectStrict(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("会话补充提示词快照 JSON 结构无效");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertTextLength(text: string): void {
  if (text.length > SYSTEM_PROMPT_ADDON_MAX_LENGTH) {
    throw new RangeError(`text must be at most ${SYSTEM_PROMPT_ADDON_MAX_LENGTH} characters`);
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, ...value }, null, 2));
}

export function readDefaultSystemPromptAddonText(agentDir = getAgentDir()): string {
  const text = readJsonObject(defaultPath(agentDir))?.text;
  return typeof text === "string" ? text : "";
}

export function writeDefaultSystemPromptAddonText(text: string, agentDir = getAgentDir()): string {
  assertTextLength(text);
  writeJson(defaultPath(agentDir), { text });
  return text;
}

function hasStandaloneBoundaries(fullText: string, start: number, end: number): boolean {
  const leftOk = start === 0 || fullText.slice(0, start).endsWith("\n\n");
  const rightOk = end === fullText.length || fullText.slice(end).startsWith("\n\n");
  return leftOk && rightOk;
}

/** 查找正文里所有作为独立段落（前后为首尾或双换行）出现的职责位置。 */
function findStandaloneRoleSegments(fullText: string, roleText: string): Array<{ start: number; end: number }> {
  if (!roleText) return [];
  const matches: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= fullText.length - roleText.length) {
    const start = fullText.indexOf(roleText, from);
    if (start < 0) break;
    const end = start + roleText.length;
    if (hasStandaloneBoundaries(fullText, start, end)) {
      matches.push({ start, end });
    }
    from = start + 1;
  }
  return matches;
}

/** 仅按记录的偏移（或无偏移时唯一独立段落）定位受管职责片段，无法确认归属时返回 null。 */
function findTrackedRoleSegment(
  fullText: string,
  roleText: string | undefined,
  roleOffset: number | undefined,
): { start: number; end: number } | null {
  if (!roleText) return null;
  if (typeof roleOffset === "number" && Number.isInteger(roleOffset) && roleOffset >= 0) {
    const end = roleOffset + roleText.length;
    if (
      end <= fullText.length
      && fullText.slice(roleOffset, end) === roleText
      && hasStandaloneBoundaries(fullText, roleOffset, end)
    ) {
      return { start: roleOffset, end };
    }
    return null;
  }
  const matches = findStandaloneRoleSegments(fullText, roleText);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 核对用户编辑前后原职责片段是否原样保留：
 * 全文提交接口无法区分“原段前插”与“改写原段并在文末新增同文示例”，
 * 因此仅当前缀与原职责片段在原位置完全未变且仍保持独立段落边界时才保留归属，其余情况一律解除团队归属。
 */
function resolvePreservedRoleOffset(
  oldText: string,
  roleText: string | undefined,
  oldOffset: number | undefined,
  nextText: string,
): number | undefined {
  const prevMatch = findTrackedRoleSegment(oldText, roleText, oldOffset);
  if (!prevMatch || !roleText) return undefined;
  if (nextText === oldText) return prevMatch.start;
  const oldBefore = oldText.slice(0, prevMatch.start);
  if (
    nextText.startsWith(`${oldBefore}${roleText}`)
    && hasStandaloneBoundaries(nextText, prevMatch.start, prevMatch.end)
  ) {
    return prevMatch.start;
  }
  return undefined;
}

function replaceOrRemoveTrackedRoleSegment(
  fullText: string,
  match: { start: number; end: number },
  nextRole: string,
): { text: string; nextOffset?: number } {
  const before = fullText.slice(0, match.start);
  const after = fullText.slice(match.end);
  if (nextRole) {
    return { text: `${before}${nextRole}${after}`, nextOffset: match.start };
  }
  const left = before.trimEnd();
  const right = after.trimStart();
  if (!left) return { text: right };
  if (!right) return { text: left };
  return { text: `${left}\n\n${right}` };
}

function recordsEqual(a: SessionSystemPromptAddonRecord | null, b: SessionSystemPromptAddonRecord | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.enabled === b.enabled
    && a.text === b.text
    && (a.teamRoleText ?? "") === (b.teamRoleText ?? "")
    && a.teamRoleOffset === b.teamRoleOffset
    && Boolean(a.teamManaged) === Boolean(b.teamManaged)
    && Boolean(a.teamRoleMigrated) === Boolean(b.teamRoleMigrated)
    && Boolean(a.fromDefault) === Boolean(b.fromDefault);
}

function parseSessionAddonRecord(stored: Record<string, unknown> | null): SessionSystemPromptAddonRecord | null {
  if (!stored || typeof stored.text !== "string") return null;
  const hasRoleText = typeof stored.teamRoleText === "string" && stored.teamRoleText.length > 0;
  const hasRoleOffset = hasRoleText
    && typeof stored.teamRoleOffset === "number"
    && Number.isInteger(stored.teamRoleOffset)
    && stored.teamRoleOffset >= 0;
  return {
    enabled: stored.enabled === true,
    text: stored.text,
    ...(hasRoleText ? { teamRoleText: stored.teamRoleText as string } : {}),
    ...(hasRoleOffset ? { teamRoleOffset: stored.teamRoleOffset as number } : {}),
    ...(stored.teamManaged === true ? { teamManaged: true } : {}),
    ...(stored.teamRoleMigrated === true ? { teamRoleMigrated: true } : {}),
    ...(stored.fromDefault === true ? { fromDefault: true } : {}),
  };
}

export function readSessionSystemPromptAddonRecord(
  sessionId: string,
  agentDir = getAgentDir(),
): SessionSystemPromptAddonRecord | null {
  return parseSessionAddonRecord(readJsonObject(sessionPath(sessionId, agentDir)));
}

function readSessionSystemPromptAddonRecordStrict(
  sessionId: string,
  agentDir = getAgentDir(),
): SessionSystemPromptAddonRecord | null {
  const stored = readJsonObjectStrict(sessionPath(sessionId, agentDir));
  if (stored === null) return null;
  const parsed = parseSessionAddonRecord(stored);
  if (!parsed) throw new Error("会话补充提示词快照缺少有效的 text 字段");
  return parsed;
}

export function readSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): SessionSystemPromptAddon | null {
  const record = readSessionSystemPromptAddonRecord(sessionId, agentDir);
  return record ? { enabled: record.enabled, text: record.text } : null;
}

/** 直接写入指定会话的补充提示词快照（不读取也不修改全局默认内容），用于团队成员等自带角色提示词的会话。 */
export function writeSessionSystemPromptAddon(
  sessionId: string,
  addon: SessionSystemPromptAddonRecord,
  agentDir = getAgentDir(),
): SessionSystemPromptAddon {
  assertTextLength(addon.text);
  const next: SessionSystemPromptAddonRecord = {
    enabled: addon.enabled === true,
    text: addon.text,
    ...(addon.teamRoleText ? { teamRoleText: addon.teamRoleText } : {}),
    ...(addon.teamRoleText && typeof addon.teamRoleOffset === "number" && Number.isInteger(addon.teamRoleOffset) && addon.teamRoleOffset >= 0
      ? { teamRoleOffset: addon.teamRoleOffset }
      : {}),
    ...(addon.teamManaged ? { teamManaged: true } : {}),
    ...(addon.teamRoleMigrated ? { teamRoleMigrated: true } : {}),
    ...(addon.fromDefault ? { fromDefault: true } : {}),
  };
  writeJson(sessionPath(sessionId, agentDir), { ...next });
  return { enabled: next.enabled, text: next.text };
}

export function removeSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): void {
  try {
    unlinkSync(sessionPath(sessionId, agentDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[pi-web] 清理会话补充提示词快照失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    }
  }
}

/** 事务内严格删除快照：仅忽略 ENOENT，其他错误向上抛出以便中止团队提交并回滚。 */
function unlinkSessionSystemPromptAddonStrict(sessionId: string, agentDir = getAgentDir()): void {
  try {
    unlinkSync(sessionPath(sessionId, agentDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** 串行化同一会话补充提示词快照的跨进程读写（顶栏修改与团队职责提交共用此锁）。 */
export async function withSessionSystemPromptAddonLock<T>(
  sessionId: string,
  operation: () => T | Promise<T>,
  agentDir = getAgentDir(),
): Promise<T> {
  const path = sessionPath(sessionId, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  return withPrivateFileLock(path, operation);
}

/** 按字典序逐个获取多个会话的补充提示词锁，避免死锁；用于解散团队等批量原子清理。 */
export async function withSessionSystemPromptAddonLocks<T>(
  sessionIds: readonly string[],
  operation: () => T | Promise<T>,
  agentDir = getAgentDir(),
): Promise<T> {
  const uniqueSorted = [...new Set(sessionIds)].sort();
  const acquire = (index: number): Promise<T> => {
    if (index >= uniqueSorted.length) return Promise.resolve(operation());
    return withSessionSystemPromptAddonLock(uniqueSorted[index], () => acquire(index + 1), agentDir);
  };
  return acquire(0);
}

/**
 * 同步更新团队成员的角色提示词到会话快照：
 * - 纯团队托管快照：保留现有开关状态，更新正文与 teamRoleText；
 * - 含 teamRoleText 的混合快照：仅替换该职责片段，保留用户自定义文本与开关状态；
 * - 用户已完全改写或无职责片段的自定义快照：不覆盖用户内容。
 */
export function syncTeamRoleIntoSessionAddon(
  sessionId: string,
  nextRolePrompt: string,
  agentDir = getAgentDir(),
): () => void {
  const trimmed = nextRolePrompt.trim();
  const existing = readSessionSystemPromptAddonRecord(sessionId, agentDir);
  let nextRecord: SessionSystemPromptAddonRecord | null = null;
  if (!existing) {
    nextRecord = {
      enabled: trimmed.length > 0,
      text: trimmed,
      teamManaged: true,
      ...(trimmed ? { teamRoleText: trimmed, teamRoleOffset: 0 } : {}),
    };
  } else if (existing.teamManaged) {
    nextRecord = {
      enabled: existing.enabled,
      text: trimmed,
      teamManaged: true,
      ...(trimmed ? { teamRoleText: trimmed, teamRoleOffset: 0 } : {}),
    };
  } else {
    const tracked = findTrackedRoleSegment(existing.text, existing.teamRoleText, existing.teamRoleOffset);
    if (tracked) {
      const { text: nextText, nextOffset } = replaceOrRemoveTrackedRoleSegment(existing.text, tracked, trimmed);
      nextRecord = {
        enabled: existing.enabled,
        text: nextText,
        teamRoleMigrated: true,
        ...(trimmed && nextOffset !== undefined ? { teamRoleText: trimmed, teamRoleOffset: nextOffset } : {}),
      };
    }
  }
  if (!nextRecord) return () => {};

  writeSessionSystemPromptAddon(sessionId, nextRecord, agentDir);
  const written = nextRecord;
  return () => {
    try {
      const current = readSessionSystemPromptAddonRecord(sessionId, agentDir);
      // 仅在磁盘仍为我们刚写入的快照时回滚，避免覆盖期间发生的并发顶栏编辑。
      if (!recordsEqual(current, written)) return;
      if (existing) {
        writeSessionSystemPromptAddon(sessionId, existing, agentDir);
      } else {
        removeSessionSystemPromptAddon(sessionId, agentDir);
      }
    } catch (error) {
      console.warn(`[pi-web] 回滚会话补充提示词快照失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    }
  };
}

interface TeamRoleMigrationPlan {
  resolution: TeamRoleAddonResolution;
  recordToWrite?: SessionSystemPromptAddonRecord;
}

/** 统一的纯判定函数：只读预览与实际迁移共用同一分支，避免规则漂移。 */
function planTeamMemberRolePromptAddon(
  existing: SessionSystemPromptAddonRecord | null,
  memberPrompt: string,
): TeamRoleMigrationPlan {
  const trimmed = memberPrompt.trim();
  if (!trimmed) {
    return {
      resolution: { mode: "snapshot", addon: existing ? { enabled: existing.enabled, text: existing.text } : null },
    };
  }
  if (existing?.teamManaged || existing?.teamRoleMigrated) {
    return {
      resolution: { mode: "snapshot", addon: { enabled: existing.enabled, text: existing.text } },
    };
  }
  if (!existing) {
    if (trimmed.length > SYSTEM_PROMPT_ADDON_MAX_LENGTH) {
      return { resolution: { mode: "separate", addon: null, separateRoleText: trimmed } };
    }
    return {
      resolution: { mode: "snapshot", addon: { enabled: true, text: trimmed } },
      recordToWrite: { enabled: true, text: trimmed, teamManaged: true, teamRoleText: trimmed, teamRoleOffset: 0 },
    };
  }
  const existingTrimmed = existing.text.trim();
  if (!existing.enabled) {
    // 仅空白快照或明确带 fromDefault 标记的默认副本才替换为团队职责；来源不明的非空停用草稿原样保留。
    if (!existingTrimmed || existing.fromDefault === true) {
      if (trimmed.length > SYSTEM_PROMPT_ADDON_MAX_LENGTH) {
        return { resolution: { mode: "separate", addon: { enabled: false, text: existing.text }, separateRoleText: trimmed } };
      }
      return {
        resolution: { mode: "snapshot", addon: { enabled: true, text: trimmed } },
        recordToWrite: { enabled: true, text: trimmed, teamManaged: true, teamRoleText: trimmed, teamRoleOffset: 0 },
      };
    }
    return { resolution: { mode: "separate", addon: { enabled: false, text: existing.text }, separateRoleText: trimmed } };
  }
  if (findStandaloneRoleSegments(existing.text, trimmed).length > 0) {
    return {
      resolution: { mode: "snapshot", addon: { enabled: true, text: existing.text } },
      recordToWrite: { enabled: true, text: existing.text, teamRoleMigrated: true },
    };
  }
  const merged = `${trimmed}\n\n${existingTrimmed}`;
  if (merged.length > SYSTEM_PROMPT_ADDON_MAX_LENGTH) {
    return { resolution: { mode: "separate", addon: { enabled: true, text: existing.text }, separateRoleText: trimmed } };
  }
  return {
    resolution: { mode: "snapshot", addon: { enabled: true, text: merged } },
    recordToWrite: { enabled: true, text: merged, teamRoleMigrated: true, teamRoleText: trimmed, teamRoleOffset: 0 },
  };
}

/** 只读判定旧团队成员职责与当前快照的生效方式（不写盘，供系统面板预览复用）。 */
export function inspectTeamMemberRolePromptAddon(
  sessionId: string,
  memberPrompt: string,
  agentDir = getAgentDir(),
): TeamRoleAddonResolution {
  let existing: SessionSystemPromptAddonRecord | null;
  try {
    existing = readSessionSystemPromptAddonRecordStrict(sessionId, agentDir);
  } catch {
    return { mode: "snapshot", addon: null };
  }
  return planTeamMemberRolePromptAddon(existing, memberPrompt).resolution;
}

/**
 * 将升级前已有的团队成员职责迁移到会话补充提示词快照中（异常隔离，不中断工具加载或顶栏读取）。
 */
/** 迁移无法落盘（加锁失败或写盘失败）时的统一降级：仅在确认职责尚未合入有效快照时走 separate 临时追加。 */
function fallbackTeamRoleResolution(
  existing: SessionSystemPromptAddonRecord | null,
  plan: TeamRoleMigrationPlan,
  memberPrompt: string,
): TeamRoleAddonResolution {
  const alreadyInActiveSnapshot = Boolean(
    existing && existing.enabled && plan.recordToWrite && plan.recordToWrite.text === existing.text,
  );
  if (plan.recordToWrite && !alreadyInActiveSnapshot) {
    return {
      mode: "separate",
      addon: existing ? { enabled: existing.enabled, text: existing.text } : null,
      separateRoleText: memberPrompt.trim(),
    };
  }
  return plan.resolution;
}

export function ensureTeamMemberRolePromptAddon(
  sessionId: string,
  memberPrompt: string,
  agentDir = getAgentDir(),
): TeamRoleAddonResolution {
  let existing: SessionSystemPromptAddonRecord | null;
  try {
    existing = readSessionSystemPromptAddonRecordStrict(sessionId, agentDir);
  } catch (error) {
    console.warn(`[pi-web] 读取团队成员补充提示词快照失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    return { mode: "snapshot", addon: null };
  }
  const plan = planTeamMemberRolePromptAddon(existing, memberPrompt);
  if (!plan.recordToWrite) return plan.resolution;
  try {
    return { mode: "snapshot", addon: writeSessionSystemPromptAddon(sessionId, plan.recordToWrite, agentDir) };
  } catch (error) {
    console.warn(`[pi-web] 迁移团队成员补充提示词失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    return fallbackTeamRoleResolution(existing, plan, memberPrompt);
  }
}

/** 持会话快照锁执行旧团队成员职责迁移；支持传入 getter 在获锁后重读成员资格，避免恢复已移除成员的旧职责。 */
export async function ensureTeamMemberRolePromptAddonLocked(
  sessionId: string,
  memberPromptOrResolver: string | (() => string | null | undefined),
  agentDir = getAgentDir(),
): Promise<TeamRoleAddonResolution> {
  const resolvePrompt = () => (typeof memberPromptOrResolver === "function"
    ? memberPromptOrResolver()
    : memberPromptOrResolver);
  try {
    return await withSessionSystemPromptAddonLock(
      sessionId,
      () => {
        const currentPrompt = resolvePrompt();
        if (currentPrompt === null || currentPrompt === undefined) {
          return { mode: "snapshot", addon: readSessionSystemPromptAddon(sessionId, agentDir) };
        }
        return ensureTeamMemberRolePromptAddon(sessionId, currentPrompt, agentDir);
      },
      agentDir,
    );
  } catch (error) {
    console.warn(`[pi-web] 加锁迁移团队成员补充提示词失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    const currentPrompt = resolvePrompt();
    if (currentPrompt === null || currentPrompt === undefined) {
      return { mode: "snapshot", addon: readSessionSystemPromptAddon(sessionId, agentDir) };
    }
    let existing: SessionSystemPromptAddonRecord | null;
    try {
      existing = readSessionSystemPromptAddonRecordStrict(sessionId, agentDir);
    } catch {
      return { mode: "snapshot", addon: null };
    }
    const plan = planTeamMemberRolePromptAddon(existing, currentPrompt);
    return fallbackTeamRoleResolution(existing, plan, currentPrompt);
  }
}

/** 移出团队或解散团队时，移除团队托管快照或仅剥离独立段落形式的职责片段，保留用户自定义文本。 */
export function cleanupTeamRoleSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): () => void {
  const existing = readSessionSystemPromptAddonRecordStrict(sessionId, agentDir);
  if (!existing) return () => {};
  let mutated = false;
  if (existing.teamManaged) {
    unlinkSessionSystemPromptAddonStrict(sessionId, agentDir);
    mutated = true;
  } else {
    const tracked = findTrackedRoleSegment(existing.text, existing.teamRoleText, existing.teamRoleOffset);
    if (tracked) {
      const { text: remaining } = replaceOrRemoveTrackedRoleSegment(existing.text, tracked, "");
      if (!remaining.trim()) {
        unlinkSessionSystemPromptAddonStrict(sessionId, agentDir);
      } else {
        writeSessionSystemPromptAddon(sessionId, { enabled: existing.enabled, text: remaining }, agentDir);
      }
      mutated = true;
    }
  }
  if (!mutated) return () => {};
  return () => {
    try {
      writeSessionSystemPromptAddon(sessionId, existing, agentDir);
    } catch (error) {
      console.warn(`[pi-web] 回滚团队职责快照清理失败 (${sessionId}):`, error instanceof Error ? error.message : error);
    }
  };
}

export async function cleanupTeamRoleSystemPromptAddonLocked(sessionId: string, agentDir = getAgentDir()): Promise<void> {
  await withSessionSystemPromptAddonLock(sessionId, () => {
    cleanupTeamRoleSystemPromptAddon(sessionId, agentDir);
  }, agentDir);
}

/** 只读：还没开始的会话看到的是当前默认内容，且不产生快照。 */
export function viewSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): SessionSystemPromptAddon {
  return readSessionSystemPromptAddon(sessionId, agentDir)
    ?? { enabled: false, text: readDefaultSystemPromptAddonText(agentDir) };
}

/** 取会话快照，没有就从当前默认内容复制一份并标记 fromDefault。 */
export function ensureSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): SessionSystemPromptAddon {
  const existing = readSessionSystemPromptAddon(sessionId, agentDir);
  if (existing) return existing;
  const created: SessionSystemPromptAddonRecord = {
    enabled: false,
    text: readDefaultSystemPromptAddonText(agentDir),
    fromDefault: true,
  };
  const path = sessionPath(sessionId, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 排他原子创建：若另一进程已先写入用户编辑，不覆盖它，直接重读现有快照。
    writePrivateFileCreateAtomicSync(path, JSON.stringify({ version: 1, ...created }, null, 2));
    return { enabled: created.enabled, text: created.text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readSessionSystemPromptAddon(sessionId, agentDir) ?? { enabled: created.enabled, text: created.text };
    }
    throw error;
  }
}

export function updateSessionSystemPromptAddon(
  sessionId: string,
  patch: Partial<SessionSystemPromptAddon>,
  agentDir = getAgentDir(),
): SessionSystemPromptAddon {
  if (patch.text !== undefined) assertTextLength(patch.text);
  const existing = readSessionSystemPromptAddonRecord(sessionId, agentDir);
  const current: SessionSystemPromptAddonRecord = existing
    ?? { enabled: false, text: readDefaultSystemPromptAddonText(agentDir), fromDefault: true };
  const nextText = patch.text !== undefined ? patch.text : current.text;
  const textEdited = patch.text !== undefined && patch.text !== current.text;
  // 依据编辑前后文本验证原职责片段是否仍原样保留；改写片段或无法确认归属时解除团队归属。
  const keptRoleOffset = resolvePreservedRoleOffset(current.text, current.teamRoleText, current.teamRoleOffset, nextText);
  const keptRoleText = keptRoleOffset !== undefined ? current.teamRoleText : undefined;
  const next: SessionSystemPromptAddonRecord = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    text: nextText,
    ...(keptRoleText !== undefined && keptRoleOffset !== undefined
      ? { teamRoleText: keptRoleText, teamRoleOffset: keptRoleOffset }
      : {}),
    ...(!textEdited && current.teamManaged ? { teamManaged: true } : {}),
    ...(current.teamRoleMigrated || (textEdited && current.teamManaged) ? { teamRoleMigrated: true } : {}),
    ...(patch.text === undefined && current.fromDefault ? { fromDefault: true } : {}),
  };
  writeJson(sessionPath(sessionId, agentDir), { ...next });
  return { enabled: next.enabled, text: next.text };
}

export async function updateSessionSystemPromptAddonLocked(
  sessionId: string,
  patch: Partial<SessionSystemPromptAddon>,
  agentDir = getAgentDir(),
): Promise<SessionSystemPromptAddon> {
  return withSessionSystemPromptAddonLock(
    sessionId,
    () => updateSessionSystemPromptAddon(sessionId, patch, agentDir),
    agentDir,
  );
}

export function appendSystemPromptAddon(systemPrompt: string, addon: SessionSystemPromptAddon): string | undefined {
  const text = addon.text.trim();
  if (!addon.enabled || !text) return undefined;
  const base = systemPrompt.trimEnd();
  return base ? `${base}\n\n${text}` : text;
}

/** 注入由独立扩展 pi-system-prompt-addon 完成，这里按它的安装路径识别。 */
export function isSystemPromptAddonExtension(extension: { path?: string }): boolean {
  return (extension.path ?? "").toLowerCase().includes("pi-system-prompt-addon");
}

/** 顶栏“系统”面板显示的提示词：与实际请求一致，且只读，查看不会提前生成快照。 */
export function withSessionSystemPromptAddon(
  systemPrompt: string,
  sessionId: string,
  agentDir = getAgentDir(),
): string {
  try {
    return appendSystemPromptAddon(systemPrompt, viewSessionSystemPromptAddon(sessionId, agentDir)) ?? systemPrompt;
  } catch {
    return systemPrompt;
  }
}

/** 顶栏“系统”面板的统一只读投影：与独立扩展及团队兜底注入保持一致，且不写盘。 */
export function projectEffectiveSystemPromptAddon(
  systemPrompt: string,
  sessionId: string,
  options: {
    addonExtensionLoaded: boolean;
    isTeamMember?: boolean;
    teamMemberPrompt?: string;
    agentDir?: string;
  },
): string {
  try {
    const agentDir = options.agentDir ?? getAgentDir();
    if (!options.isTeamMember) {
      return options.addonExtensionLoaded
        ? withSessionSystemPromptAddon(systemPrompt, sessionId, agentDir)
        : systemPrompt;
    }
    const resolution = inspectTeamMemberRolePromptAddon(sessionId, options.teamMemberPrompt ?? "", agentDir);
    let projected = systemPrompt;
    if (resolution.mode === "snapshot") {
      if (resolution.addon) {
        projected = appendSystemPromptAddon(projected, resolution.addon) ?? projected;
      }
      return projected;
    }
    if (resolution.addon) {
      projected = appendSystemPromptAddon(projected, resolution.addon) ?? projected;
    }
    if (resolution.separateRoleText) {
      projected = appendSystemPromptAddon(projected, { enabled: true, text: resolution.separateRoleText }) ?? projected;
    }
    return projected;
  } catch {
    return systemPrompt;
  }
}
