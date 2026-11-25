import { existsSync, statSync, unlinkSync } from "node:fs";
import { uuidv7 } from "@earendil-works/pi-ai";
import { createAgentSessionServices, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { findDeferredStartupModel } from "./deferred-provider-models";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { llamaCppExtension } from "./pi-sdk-internals";
import { projectTrustReloadOptions } from "./project-trust";
import { writePrivateFileCreateAtomicSync } from "./atomic-file";
import { allowFileRoot } from "./file-access";
import { getRpcSession, getRunningRpcSessionIds } from "./rpc-manager";
import {
  getLatestModelChange,
  invalidateSessionListCache,
  resolveSessionPath,
} from "./session-reader";
import { wakeSession, type WakeDelivery } from "./session-wake";
import {
  cleanupTeamRoleSystemPromptAddon,
  removeSessionSystemPromptAddon,
  syncTeamRoleIntoSessionAddon,
  withSessionSystemPromptAddonLock,
  withSessionSystemPromptAddonLocks,
  writeSessionSystemPromptAddon,
} from "./system-prompt-addon";
import { isThinkingLevel, type ThinkingLevel } from "./thinking-levels";
import {
  DEFAULT_TEAM_LEADER_PROMPT,
  TEAM_MEMBER_ENTRY_TYPE,
  type Team,
  type TeamCard,
  type TeamMember,
} from "./team-types";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  rebuildTeam,
  TeamEditConflictError,
  removeTeamMember,
  resolveMember,
  updateTeamMember,
  validateMemberDraft,
  validateTeamDraft,
} from "./teams";
import { TEAM_MESSAGE_TYPE } from "./wake-message-types";
import type { SessionEntry } from "./types";

/**
 * 团队运行时：成员会话创建、模型/思考强度继承、成员间消息投递（含防死循环限制）以及待审核自动通知。
 */

export const MAX_TEAM_MESSAGE_HOPS = 6;
const PAIR_WINDOW_MS = 60_000;
const MAX_PAIR_MESSAGES_PER_WINDOW = 10;

interface TeamRelayState {
  pairTimestamps: Map<string, number[]>;
}

const globalRelay = globalThis as typeof globalThis & { __piWebTeamRelay?: TeamRelayState };
function getRelayState(): TeamRelayState {
  if (!globalRelay.__piWebTeamRelay) {
    globalRelay.__piWebTeamRelay = { pairTimestamps: new Map() };
  }
  return globalRelay.__piWebTeamRelay;
}

export interface MemberModelSpec {
  provider: string;
  modelId: string;
}

export interface InheritedSessionConfig {
  cwd: string;
  model?: MemberModelSpec;
  thinkingLevel?: ThinkingLevel;
}

/** 按会话启动相同的模型范围与档位规则解析默认配置，供 leader 未启动或未显式落盘时继承。 */
async function resolveDefaultModelConfigForCwd(cwd: string, explicitModel?: MemberModelSpec): Promise<{
  model?: MemberModelSpec;
  thinkingLevel?: ThinkingLevel;
}> {
  if (!cwd || !existsSync(cwd)) return {};
  try {
    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: [llamaCppExtension] },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const settings = services.settingsManager;
    const enabledModels = settings.getEnabledModels();
    // 与 rpc-manager.ts 启动路径保持同一套 SDK 运行时模型范围，不套用 Web 选择器的 models.json 列表过滤。
    const scope = await resolveVisibleModels(services.modelRuntime, enabledModels);
    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    const defaultModel = defaultProvider && defaultModelId
      ? { provider: defaultProvider, modelId: defaultModelId }
      : undefined;

    let model = explicitModel;
    let scopedThinking: ThinkingLevel | undefined;
    if (model) {
      scopedThinking = scope.scopedModels.find(
        (scoped) => scoped.model.provider === model!.provider && scoped.model.id === model!.modelId,
      )?.thinkingLevel;
      if (!scopedThinking && !services.modelRuntime.getModel(model.provider, model.modelId)) {
        const deferred = await findDeferredStartupModel(services.modelRuntime, enabledModels, {
          requestedModel: model,
        });
        scopedThinking = deferred?.thinkingLevelPin;
      }
    } else {
      const initial = selectInitialModelScope(scope, {
        ...(defaultModel ? { defaultModel } : {}),
      });
      const startsOnDefault = Boolean(initial.model && defaultModel
        && initial.model.provider === defaultModel.provider && initial.model.id === defaultModel.modelId
        && (scope.scopedModels.length > 0 || !enabledModels?.some((pattern) => pattern.trim())));
      const deferredStartup = !startsOnDefault
        ? await findDeferredStartupModel(services.modelRuntime, enabledModels, defaultModel ? { defaultModel } : {})
        : undefined;
      const resolved = deferredStartup?.model ?? initial.model;
      if (resolved) {
        model = { provider: resolved.provider, modelId: resolved.id };
      }
      scopedThinking = deferredStartup ? deferredStartup.thinkingLevelPin : initial.thinkingLevel;
    }

    const rawThinking = scopedThinking
      ?? (model ? settings.getModelThinkingLevel(model.provider, model.modelId) : undefined)
      ?? settings.getDefaultThinkingLevel();
    const thinkingLevel = isThinkingLevel(rawThinking) ? rawThinking : undefined;
    return {
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  } catch (error) {
    console.warn(`[pi-web] 解析目录 ${cwd} 默认模型配置失败:`, error instanceof Error ? error.message : error);
    return {};
  }
}

/** 读取某个成员当前生效的模型与思考强度，新建成员未显式指定时从 leader 抄一份。 */
export async function readSessionModelConfig(
  sessionId: string,
  fallbackCwd?: string,
): Promise<Partial<InheritedSessionConfig>> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    // 复用 startupModel()，避免 leader 仍在等待延迟 provider 切模时读到占位模型。
    const startup = typeof live.startupModel === "function" ? live.startupModel() : undefined;
    const rawModel = startup?.model ?? live.inner.model;
    const model = rawModel
      ? { provider: rawModel.provider, modelId: rawModel.id }
      : undefined;
    const rawThinking = startup?.thinkingLevel ?? live.inner.agent.state?.thinkingLevel;
    const thinkingLevel = isThinkingLevel(rawThinking) ? rawThinking : undefined;
    const defaults = !model || !thinkingLevel ? await resolveDefaultModelConfigForCwd(live.cwd, model) : {};
    const resolvedModel = model ?? defaults.model;
    const resolvedThinking = thinkingLevel ?? defaults.thinkingLevel;
    return {
      cwd: live.cwd,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
    };
  }

  let effectiveCwd = fallbackCwd;
  let model: MemberModelSpec | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  const sessionFile = await resolveSessionPath(sessionId);
  if (sessionFile && existsSync(sessionFile)) {
    try {
      const manager = SessionManager.open(sessionFile, undefined);
      effectiveCwd = manager.getCwd();
      const branch = manager.getBranch() as unknown as SessionEntry[];
      const savedModel = getLatestModelChange(branch);
      const savedThinking = branch.findLast(
        (entry) => entry.type === "thinking_level_change",
      ) as { thinkingLevel?: unknown } | undefined;
      if (savedModel) model = { provider: savedModel.provider, modelId: savedModel.modelId };
      if (savedThinking && isThinkingLevel(savedThinking.thinkingLevel)) {
        thinkingLevel = savedThinking.thinkingLevel;
      }
    } catch (error) {
      console.warn(`[pi-web] 读取会话 ${sessionId} 模型配置失败:`, error instanceof Error ? error.message : error);
    }
  }

  if (effectiveCwd && (!model || !thinkingLevel)) {
    const defaults = await resolveDefaultModelConfigForCwd(effectiveCwd, model);
    model = model ?? defaults.model;
    thinkingLevel = thinkingLevel ?? defaults.thinkingLevel;
  }

  return {
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function cleanupOrphanSessionFile(sessionFile: string): void {
  try {
    unlinkSync(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[pi-web] 清理失败的孤立成员会话文件出错 (${sessionFile}):`, error instanceof Error ? error.message : error);
    }
  }
  invalidateSessionListCache();
}

export interface CreateMemberSessionInput {
  cwd: string;
  displayName: string;
  teamId?: string;
  memberName: string;
  model?: MemberModelSpec;
  thinkingLevel?: ThinkingLevel;
}

function assertTeamWorkingDirectory(cwd: string): void {
  if (!cwd) throw new Error("工作目录不能为空");
  const cwdStats = statSync(cwd, { throwIfNoEntry: false });
  if (!cwdStats) throw new Error(`工作目录不存在: ${cwd}`);
  if (!cwdStats.isDirectory()) throw new Error(`工作目录必须是目录: ${cwd}`);
}

/** 准备会话参数，调用方决定何时发布。 */
function prepareTeamMemberSession(input: CreateMemberSessionInput) {
  const cwd = input.cwd.trim();
  assertTeamWorkingDirectory(cwd);
  return { ...input, cwd, sessionId: uuidv7() };
}

function publishTeamMemberSession(
  input: ReturnType<typeof prepareTeamMemberSession>,
  requiresTeamRebuildCommit = false,
): string {
  const sessionManager = SessionManager.create(input.cwd, undefined, { id: input.sessionId });
  if (input.model) {
    sessionManager.appendModelChange(input.model.provider, input.model.modelId);
  }
  if (input.thinkingLevel) {
    sessionManager.appendThinkingLevelChange(input.thinkingLevel);
  }
  sessionManager.appendSessionInfo(input.displayName);
  sessionManager.appendCustomEntry(TEAM_MEMBER_ENTRY_TYPE, {
    version: 1,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    memberName: input.memberName,
  });

  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) throw new Error("无法创建成员会话文件");
  const fileHeader = requiresTeamRebuildCommit ? { ...header, requiresTeamRebuildCommit: true } : header;
  const lines = [fileHeader, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writePrivateFileCreateAtomicSync(sessionFile, `${lines.join("\n")}\n`);
  invalidateSessionListCache();
  return sessionFile;
}

export function createTeamMemberSessionFile(input: CreateMemberSessionInput): { sessionId: string; sessionFile: string } {
  const session = prepareTeamMemberSession(input);
  const sessionFile = publishTeamMemberSession(session);
  allowFileRoot(session.cwd);
  return { sessionId: session.sessionId, sessionFile };
}

export interface ProvisionTeamInput {
  name: string;
  prompt?: string;
  cwd: string;
  leaderName?: string;
  leaderTitle?: string;
  leaderPrompt?: string;
  model?: MemberModelSpec;
  thinkingLevel?: ThinkingLevel;
}

/** 初始化成员会话的补充提示词快照（先于团队提交，失败时一并回滚）。 */
function initMemberRolePromptAddon(sessionId: string, prompt?: string): void {
  const trimmed = (prompt ?? "").trim();
  writeSessionSystemPromptAddon(sessionId, {
    enabled: trimmed.length > 0,
    text: trimmed,
    teamManaged: true,
    ...(trimmed ? { teamRoleText: trimmed, teamRoleOffset: 0 } : {}),
  });
}

/** 创建团队，同时为 leader 建好独立会话与角色补充提示词快照。 */
export async function provisionTeam(input: ProvisionTeamInput): Promise<Team> {
  const leaderName = input.leaderName?.trim() || "leader";
  const leaderTitle = input.leaderTitle?.trim() || "Leader";
  const leaderPrompt = input.leaderPrompt ?? DEFAULT_TEAM_LEADER_PROMPT;
  validateTeamDraft({
    name: input.name,
    prompt: input.prompt,
    leader: { name: leaderName, title: leaderTitle, prompt: leaderPrompt },
  });
  const { sessionId, sessionFile } = createTeamMemberSessionFile({
    cwd: input.cwd,
    displayName: `${input.name.trim()} · ${leaderName}`,
    memberName: leaderName,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
  });
  try {
    initMemberRolePromptAddon(sessionId, leaderPrompt);
    return await createTeam({
      name: input.name,
      prompt: input.prompt,
      leader: {
        sessionId,
        name: leaderName,
        title: leaderTitle,
        prompt: leaderPrompt,
        cwd: input.cwd.trim(),
      },
    });
  } catch (error) {
    removeSessionSystemPromptAddon(sessionId);
    cleanupOrphanSessionFile(sessionFile);
    throw error;
  }
}

/** 编辑后重建 leader；旧成员会话转为普通会话，团队角色快照与团队记录一起提交或回滚。 */
export async function rebuildTeamWithCleanup(
  teamId: string,
  input: ProvisionTeamInput & { expectedUpdatedAt: number },
): Promise<Team> {
  const previous = getTeam(teamId);
  if (!previous) throw new Error("团队不存在");
  if (previous.updatedAt !== input.expectedUpdatedAt) throw new TeamEditConflictError();
  const leader = previous.members.find((member) => member.role === "leader");
  const inherited = leader ? await readSessionModelConfig(leader.sessionId, leader.cwd) : {};
  const leaderName = input.leaderName?.trim() || "leader";
  const leaderTitle = input.leaderTitle?.trim() ?? leader?.title ?? "Leader";
  const created = prepareTeamMemberSession({
    cwd: input.cwd,
    displayName: `${input.name.trim()} · ${leaderName}`,
    teamId,
    memberName: leaderName,
    model: input.model ?? inherited.model,
    thinkingLevel: input.thinkingLevel ?? inherited.thinkingLevel,
  });
  let committed = false;
  try {
    initMemberRolePromptAddon(created.sessionId, input.leaderPrompt);
    return await rebuildTeam(teamId, {
      name: input.name,
      prompt: input.prompt,
      expectedUpdatedAt: input.expectedUpdatedAt,
      leader: { sessionId: created.sessionId, name: leaderName, title: leaderTitle, prompt: input.leaderPrompt, cwd: created.cwd },
    }, undefined, {
      aroundSave: async (current, commitTeams) => {
        await withSessionSystemPromptAddonLocks(current.members.map((member) => member.sessionId), () => {
          assertTeamWorkingDirectory(created.cwd);
          const rollbacks: Array<() => void> = [];
          try {
            for (const member of current.members) rollbacks.push(cleanupTeamRoleSystemPromptAddon(member.sessionId));
            // 会话目录也是文件访问授权来源，版本和输入通过锁内校验后才发布。
            const sessionFile = publishTeamMemberSession(created, true);
            rollbacks.push(() => cleanupOrphanSessionFile(sessionFile));
            commitTeams();
            committed = true;
          } catch (error) {
            for (const rollback of rollbacks.reverse()) rollback();
            throw error;
          }
          allowFileRoot(created.cwd);
        });
      },
    });
  } catch (error) {
    if (!committed) removeSessionSystemPromptAddon(created.sessionId);
    throw error;
  }
}

export interface ProvisionMemberInput {
  teamId: string;
  name: string;
  title?: string;
  prompt?: string;
  /** 缺省继承 leader 的工作目录。 */
  cwd?: string;
  /** 缺省在创建那一刻从 leader 抄一份模型。 */
  model?: MemberModelSpec;
  /** 缺省在创建那一刻从 leader 抄一份思考强度。 */
  thinkingLevel?: ThinkingLevel;
}

/** 在现有团队里创建一名新成员并为其建好独立会话（cwd / 模型 / 思考强度默认抄 leader）。 */
export async function provisionTeamMember(input: ProvisionMemberInput): Promise<TeamMember> {
  validateMemberDraft(input.teamId, { name: input.name, title: input.title, prompt: input.prompt });
  const team = getTeam(input.teamId);
  if (!team) throw new Error(`团队 ${input.teamId} 不存在`);
  const leader = team.members.find((member) => member.role === "leader");
  const inherited = leader ? await readSessionModelConfig(leader.sessionId, leader.cwd) : {};
  const cwd = input.cwd?.trim() || inherited.cwd || leader?.cwd || "";
  if (!cwd) throw new Error("缺少工作目录，且无法从 leader 继承");
  const model = input.model ?? inherited.model;
  const thinkingLevel = input.thinkingLevel ?? inherited.thinkingLevel;

  const { sessionId, sessionFile } = createTeamMemberSessionFile({
    cwd,
    displayName: `${team.name} · ${input.name.trim()}`,
    teamId: team.id,
    memberName: input.name.trim(),
    model,
    thinkingLevel,
  });

  try {
    initMemberRolePromptAddon(sessionId, input.prompt);
    return await addTeamMember(team.id, {
      sessionId,
      name: input.name,
      title: input.title,
      prompt: input.prompt,
      cwd,
    });
  } catch (error) {
    removeSessionSystemPromptAddon(sessionId);
    cleanupOrphanSessionFile(sessionFile);
    throw error;
  }
}

/** 更新成员资料并在团队文件锁内同步角色补充提示词快照；快照失败时中止提交，避免脏写或并发覆盖。 */
export async function updateTeamMemberWithPrompt(
  teamId: string,
  memberId: string,
  patch: { name?: string; title?: string; prompt?: string },
): Promise<TeamMember> {
  return updateTeamMember(teamId, memberId, patch, undefined, undefined, {
    aroundSave: patch.prompt !== undefined
      ? async (updated, _previous, commitTeams) => {
        // 持会话快照锁完成职责写入、团队落盘与失败回滚，避免跨进程顶栏切换开关打断回滚。
        await withSessionSystemPromptAddonLock(updated.sessionId, () => {
          const rollback = syncTeamRoleIntoSessionAddon(updated.sessionId, updated.prompt);
          try {
            commitTeams();
          } catch (error) {
            rollback();
            throw error;
          }
        });
      }
      : undefined,
  });
}

/** 移出成员前先持会话快照锁清理其团队托管角色，团队落盘失败时回滚快照清理，避免删人后留下生效旧职责。 */
export async function removeTeamMemberWithCleanup(teamId: string, memberId: string): Promise<TeamMember> {
  return removeTeamMember(teamId, memberId, undefined, undefined, {
    aroundSave: async (removed, commitTeams) => {
      await withSessionSystemPromptAddonLock(removed.sessionId, () => {
        const rollback = cleanupTeamRoleSystemPromptAddon(removed.sessionId);
        try {
          commitTeams();
        } catch (error) {
          rollback();
          throw error;
        }
      });
    },
  });
}

/** 解散团队前按字典序持全部成员快照锁清理团队托管角色；任一失败时回滚已清理快照且不提交删除。 */
export async function disbandTeamWithCleanup(teamId: string): Promise<Team | undefined> {
  return deleteTeam(teamId, undefined, {
    aroundDelete: async (deleted, commitTeams) => {
      await withSessionSystemPromptAddonLocks(
        deleted.members.map((member) => member.sessionId),
        () => {
          const rollbacks: Array<() => void> = [];
          try {
            for (const member of deleted.members) {
              rollbacks.push(cleanupTeamRoleSystemPromptAddon(member.sessionId));
            }
            commitTeams();
          } catch (error) {
            for (let i = rollbacks.length - 1; i >= 0; i -= 1) {
              rollbacks[i]();
            }
            throw error;
          }
        },
      );
    },
  });
}

export interface SendTeamMessageInput {
  team: Team;
  from: TeamMember;
  toNameOrId: string;
  message: string;
  delivery?: WakeDelivery;
  /** 当前轮次已发生的转发跳数；人类直接发起为 0。 */
  currentHop?: number;
}

/** 检查并记录一对成员间的发送频率，防止两个 bot 互相确认进入死循环。 */
function checkPairRateLimit(teamId: string, fromId: string, toId: string, now = Date.now()): void {
  const state = getRelayState();
  const key = `${teamId}:${fromId}->${toId}`;
  const recent = (state.pairTimestamps.get(key) ?? []).filter((ts) => now - ts < PAIR_WINDOW_MS);
  if (recent.length >= MAX_PAIR_MESSAGES_PER_WINDOW) {
    throw new Error(`向该成员发送过于频繁（1 分钟内最多 ${MAX_PAIR_MESSAGES_PER_WINDOW} 条），请合并信息后再发或先更新看板。`);
  }
  recent.push(now);
  state.pairTimestamps.set(key, recent);
}

/** 发送团队消息：走 session-wake 唤醒目标成员会话。 */
export async function sendTeamMessage(input: SendTeamMessageInput): Promise<{ to: TeamMember; hop: number }> {
  const body = input.message.trim();
  if (!body) throw new Error("消息内容不能为空");
  const target = resolveMember(input.team, input.toNameOrId);
  if (!target) throw new Error(`团队里找不到成员 "${input.toNameOrId}"`);
  if (target.id === input.from.id) throw new Error("不能给自己发团队消息");

  const nextHop = (input.currentHop ?? 0) + 1;
  if (nextHop > MAX_TEAM_MESSAGE_HOPS) {
    throw new Error(`本条消息链已连续转发 ${MAX_TEAM_MESSAGE_HOPS} 次，已停止继续转发以防死循环。请更新看板或等待用户进一步指示。`);
  }
  checkPairRateLimit(input.team.id, input.from.id, target.id);

  const fromLabel = input.from.title ? `${input.from.name}（${input.from.title}）` : input.from.name;
  const content = `[团队消息 · 来自 ${fromLabel}]\n${body}`;
  await wakeSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    customType: TEAM_MESSAGE_TYPE,
    content,
    details: {
      teamId: input.team.id,
      fromMemberId: input.from.id,
      fromName: input.from.name,
      toMemberId: target.id,
      toName: target.name,
      hop: nextHop,
    },
    delivery: input.delivery ?? "followUp",
    onLateError: (error) => {
      console.warn(`[pi-web] 团队消息后续执行失败 (${input.from.name} -> ${target.name}):`, error);
    },
  });
  return { to: target, hop: nextHop };
}

/** 当卡片流转到 review 且指定了审核人时，自动发一条团队消息通知审核人。 */
export async function notifyCardReviewer(options: {
  team: Team;
  card: TeamCard;
  actorName: string;
  actorId?: string;
  note?: string;
  currentHop?: number;
}): Promise<{ notified: boolean; reviewerName?: string; error?: string }> {
  if (options.card.status !== "review" || !options.card.reviewerId) {
    return { notified: false };
  }
  if (options.actorId && options.card.reviewerId === options.actorId) {
    return { notified: false };
  }
  const reviewer = options.team.members.find((member) => member.id === options.card.reviewerId);
  if (!reviewer) return { notified: false };

  const nextHop = (options.currentHop ?? 0) + 1;
  if (nextHop > MAX_TEAM_MESSAGE_HOPS) {
    return { notified: false, reviewerName: reviewer.name, error: "已达转发跳数上限，未自动唤醒审核人" };
  }
  const assignee = options.card.assigneeId
    ? options.team.members.find((member) => member.id === options.card.assigneeId)?.name
    : undefined;
  const lines = [
    `[看板待审核通知] 卡片 [${options.card.id}]「${options.card.title}」已由 ${options.actorName} 移至待审核。`,
    ...(assignee ? [`负责人：${assignee}`] : []),
    ...(options.card.description ? [`描述：${options.card.description}`] : []),
    ...(options.note ? [`说明：${options.note}`] : []),
    `请审核后使用 board_update 更新该卡片状态（done / doing / blocked）并写明审核结论。`,
  ];
  try {
    await wakeSession({
      sessionId: reviewer.sessionId,
      cwd: reviewer.cwd,
      customType: TEAM_MESSAGE_TYPE,
      content: lines.join("\n"),
      details: {
        teamId: options.team.id,
        cardId: options.card.id,
        fromName: options.actorName,
        toMemberId: reviewer.id,
        toName: reviewer.name,
        kind: "review-request",
        hop: nextHop,
      },
      delivery: "followUp",
      onLateError: (error) => {
        console.warn(`[pi-web] 审核通知执行失败 (${options.card.id} -> ${reviewer.name}):`, error);
      },
    });
    return { notified: true, reviewerName: reviewer.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-web] 无法通知审核人 ${reviewer.name}:`, message);
    return { notified: false, reviewerName: reviewer.name, error: message };
  }
}

/** 结合运行中会话集合，格式化成员当前状态，供 team_list 与看板使用。 */
export function getMemberRuntimeStatus(sessionId: string): "running" | "idle" {
  return getRunningRpcSessionIds().includes(sessionId) ? "running" : "idle";
}
