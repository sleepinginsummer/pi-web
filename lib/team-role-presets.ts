import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 团队角色预设持久化存储（~/.pi/agent/team-role-presets.json）。
 * 每条预设只存角色名称与角色提示词；跨团队复用，由用户界面或团队 Leader 工具增删改查。
 */

export const MAX_ROLE_PRESETS = 100;
export const MAX_PRESET_NAME_LENGTH = 60;
export const MAX_PRESET_PROMPT_LENGTH = 4000;

export interface TeamRolePreset {
  id: string;
  /** 预设名称（如“后端开发”“代码审核”），选用时自动作为成员职位。 */
  name: string;
  /** 角色提示词，选用时写入成员会话的补充提示词快照。 */
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  presets: TeamRolePreset[];
}

export function getTeamRolePresetsPath(): string {
  return join(getAgentDir(), "team-role-presets.json");
}

function newPresetId(): string {
  return `rp_${randomBytes(6).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizePreset(raw: unknown): TeamRolePreset | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const name = raw.name.trim();
  if (!name) return null;
  return {
    id: raw.id,
    name,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

/** 仅在持锁写入路径传 recoverCorrupt=true；只读路径不写盘，写入路径遇非 ENOENT 读取失败或备份失败时中止写入。 */
function readPresets(path: string, recoverCorrupt = false): TeamRolePreset[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!recoverCorrupt) {
      console.warn("[pi-web] 角色预设存储无法读取:", error instanceof Error ? error.message : error);
      return [];
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.presets)) {
      throw new SyntaxError("角色预设存储根节点无效");
    }
    return parsed.presets.map(sanitizePreset).filter((item): item is TeamRolePreset => item !== null);
  } catch (error) {
    if (!recoverCorrupt) {
      console.warn("[pi-web] 角色预设存储格式无效:", error instanceof Error ? error.message : error);
      return [];
    }
    console.warn("[pi-web] 角色预设存储格式损坏，备份后从空开始:", error instanceof Error ? error.message : error);
    // 必须先成功备份原文件才允许重置，避免备份失败时静默覆盖数据。
    writePrivateFileAtomicSync(`${path}.corrupt-${Date.now()}`, raw);
    writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, presets: [] }, null, 2));
    return [];
  }
}

function writePresets(path: string, presets: TeamRolePreset[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, presets } satisfies StoreFile, null, 2));
}

function nextPresetUpdatedAt(currentUpdatedAt: number, now: number): number {
  return now > currentUpdatedAt ? now : currentUpdatedAt + 1;
}

async function mutate<T>(
  operation: (presets: TeamRolePreset[], now: number) => { presets: TeamRolePreset[]; result: T },
  path: string,
  now?: number,
): Promise<T> {
  return withPrivateFileLock(path, () => {
    const ts = now ?? Date.now();
    const { presets, result } = operation(readPresets(path, true), ts);
    writePresets(path, presets);
    return result;
  });
}

function checkName(presets: readonly TeamRolePreset[], value: unknown, exceptId?: string): string {
  if (typeof value !== "string") throw new Error("角色名称必须是字符串");
  const name = value.trim();
  if (!name) throw new Error("角色名称不能为空");
  if (name.length > MAX_PRESET_NAME_LENGTH) throw new Error(`角色名称不能超过 ${MAX_PRESET_NAME_LENGTH} 个字符`);
  if (presets.some((item) => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`已存在名为「${name}」的角色预设`);
  }
  return name;
}

function checkPrompt(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("角色提示词必须是字符串");
  const text = value.trim();
  if (text.length > MAX_PRESET_PROMPT_LENGTH) throw new Error(`角色提示词不能超过 ${MAX_PRESET_PROMPT_LENGTH} 个字符`);
  return text;
}

export type PresetMatchMode = "id" | "idOrName";

function findPreset(
  presets: readonly TeamRolePreset[],
  idOrName: string,
  matchBy: PresetMatchMode = "idOrName",
): TeamRolePreset | undefined {
  const byId = presets.find((item) => item.id === idOrName);
  if (byId || matchBy === "id") return byId;
  const key = idOrName.trim().toLowerCase();
  if (!key) return undefined;
  return presets.find((item) => item.name.toLowerCase() === key);
}

export class TeamRolePresetConflictError extends Error {
  readonly preset: TeamRolePreset;

  constructor(preset: TeamRolePreset) {
    super("该角色预设已被其他操作更新，请核对最新内容后再保存");
    this.name = "TeamRolePresetConflictError";
    this.preset = preset;
  }
}

export function listTeamRolePresets(path = getTeamRolePresetsPath()): TeamRolePreset[] {
  return readPresets(path).sort((a, b) => a.createdAt - b.createdAt);
}

export function getTeamRolePreset(
  idOrName: string,
  path = getTeamRolePresetsPath(),
  matchBy: PresetMatchMode = "idOrName",
): TeamRolePreset | undefined {
  return findPreset(readPresets(path), idOrName, matchBy);
}

export async function createTeamRolePreset(
  input: { name: string; prompt?: string },
  now?: number,
  path = getTeamRolePresetsPath(),
): Promise<TeamRolePreset> {
  return mutate((presets, ts) => {
    if (presets.length >= MAX_ROLE_PRESETS) throw new Error(`最多保存 ${MAX_ROLE_PRESETS} 个角色预设`);
    const preset: TeamRolePreset = {
      id: newPresetId(),
      name: checkName(presets, input.name),
      prompt: checkPrompt(input.prompt),
      createdAt: ts,
      updatedAt: ts,
    };
    return { presets: [...presets, preset], result: preset };
  }, path, now);
}

export async function updateTeamRolePreset(
  idOrName: string,
  patch: { name?: string; prompt?: string; expectedUpdatedAt?: number },
  now?: number,
  path = getTeamRolePresetsPath(),
  options?: { matchBy?: PresetMatchMode },
): Promise<TeamRolePreset> {
  return mutate((presets, ts) => {
    const current = findPreset(presets, idOrName, options?.matchBy ?? "idOrName");
    if (!current) throw new Error(`角色预设「${idOrName}」不存在`);
    if (patch.expectedUpdatedAt !== undefined && current.updatedAt !== patch.expectedUpdatedAt) {
      throw new TeamRolePresetConflictError(current);
    }
    const next: TeamRolePreset = {
      ...current,
      ...(patch.name !== undefined ? { name: checkName(presets, patch.name, current.id) } : {}),
      ...(patch.prompt !== undefined ? { prompt: checkPrompt(patch.prompt) } : {}),
      updatedAt: nextPresetUpdatedAt(current.updatedAt, ts),
    };
    return {
      presets: presets.map((item) => (item.id === current.id ? next : item)),
      result: next,
    };
  }, path, now);
}

export async function deleteTeamRolePreset(
  idOrName: string,
  now?: number,
  path = getTeamRolePresetsPath(),
  options?: { matchBy?: PresetMatchMode; expectedUpdatedAt?: number },
): Promise<TeamRolePreset | undefined> {
  return mutate((presets) => {
    const target = findPreset(presets, idOrName, options?.matchBy ?? "idOrName");
    if (!target) return { presets, result: undefined };
    if (options?.expectedUpdatedAt !== undefined && target.updatedAt !== options.expectedUpdatedAt) {
      throw new TeamRolePresetConflictError(target);
    }
    return {
      presets: presets.filter((item) => item.id !== target.id),
      result: target,
    };
  }, path, now);
}
