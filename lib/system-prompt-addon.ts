import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 顶栏“补充提示词”。全局文件只保存新会话的默认内容；会话开始（首条消息，或第一次在
 * 该会话里操作）时复制一份到自己的快照文件，此后开关和内容都只读写这份快照，
 * 改全局或别的会话都影响不到它。在会话里改内容会同时更新默认内容，只影响之后的新会话。快照默认关闭，不写会话 JSONL，没有存活 wrapper 的
 * 历史会话也能操作。这个文件只管界面读写，实际注入在独立扩展 pi-system-prompt-addon，
 * 磁盘格式两边共用，改格式要一起改。
 */

export const SYSTEM_PROMPT_ADDON_MAX_LENGTH = 100_000;

export interface SessionSystemPromptAddon {
  enabled: boolean;
  text: string;
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

function readSessionSnapshot(sessionId: string, agentDir: string): SessionSystemPromptAddon | null {
  const stored = readJsonObject(sessionPath(sessionId, agentDir));
  if (!stored || typeof stored.text !== "string") return null;
  return { enabled: stored.enabled === true, text: stored.text };
}

/** 只读：还没开始的会话看到的是当前默认内容，且不产生快照。 */
export function viewSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): SessionSystemPromptAddon {
  return readSessionSnapshot(sessionId, agentDir)
    ?? { enabled: false, text: readDefaultSystemPromptAddonText(agentDir) };
}

/** 取会话快照，没有就从当前默认内容复制一份。 */
export function ensureSessionSystemPromptAddon(sessionId: string, agentDir = getAgentDir()): SessionSystemPromptAddon {
  const existing = readSessionSnapshot(sessionId, agentDir);
  if (existing) return existing;
  const created = { enabled: false, text: readDefaultSystemPromptAddonText(agentDir) };
  writeJson(sessionPath(sessionId, agentDir), { ...created });
  return created;
}

export function updateSessionSystemPromptAddon(
  sessionId: string,
  patch: Partial<SessionSystemPromptAddon>,
  agentDir = getAgentDir(),
): SessionSystemPromptAddon {
  if (patch.text !== undefined) assertTextLength(patch.text);
  const current = ensureSessionSystemPromptAddon(sessionId, agentDir);
  const next = { ...current, ...patch };
  writeJson(sessionPath(sessionId, agentDir), { ...next });
  // 最后一次改动的内容作为之后新会话的默认值，已开始的会话有自己的快照，不受影响。
  // 清空通常只是想停用当前会话，不算一份可复用的内容；没变的保存也不能拿旧文本覆盖默认值。
  if (patch.text !== undefined && patch.text !== current.text && patch.text.trim()) {
    writeDefaultSystemPromptAddonText(patch.text, agentDir);
  }
  return next;
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
export function withSessionSystemPromptAddon(systemPrompt: string, sessionId: string): string {
  try {
    return appendSystemPromptAddon(systemPrompt, viewSessionSystemPromptAddon(sessionId)) ?? systemPrompt;
  } catch {
    return systemPrompt;
  }
}
