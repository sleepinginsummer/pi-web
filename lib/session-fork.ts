import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { writePrivateFileCreateAtomicSync } from "./atomic-file";

export interface ForkedSession {
  newSessionId: string;
  newSessionFile: string;
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message";
}

type ToolResultEntry = SessionMessageEntry & {
  message: Extract<SessionMessageEntry["message"], { role: "toolResult" }>;
};

function isToolResultEntry(entry: SessionEntry): entry is ToolResultEntry {
  return isMessageEntry(entry) && entry.message.role === "toolResult";
}

/** 从 SDK 原始 assistant 消息中提取工具调用 ID。 */
function getToolCallIds(entry: SessionMessageEntry): string[] {
  if (entry.message.role !== "assistant") return [];
  return entry.message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
}

/**
 * 工具结果是 assistant 后续的独立树节点。分叉 assistant 时必须把本轮所有
 * 工具结果一并纳入，否则新会话会留下无法恢复的未完成工具调用。
 */
function resolveAssistantLeaf(entry: SessionMessageEntry, entries: SessionEntry[]): string {
  const pendingToolCallIds = new Set(getToolCallIds(entry));
  if (pendingToolCallIds.size === 0) return entry.id;

  let leafId = entry.id;
  while (pendingToolCallIds.size > 0) {
    const result = entries.find((candidate): candidate is ToolResultEntry => (
      candidate.parentId === leafId
      && isToolResultEntry(candidate)
      && pendingToolCallIds.has(candidate.message.toolCallId)
    ));
    if (!result) {
      throw new Error("Cannot fork an assistant message with unfinished tool calls");
    }
    pendingToolCallIds.delete(result.message.toolCallId);
    leafId = result.id;
  }
  return leafId;
}

/** SDK 可能延迟写盘，统一从 manager 序列化完整 JSONL。 */
function serializeSession(manager: SessionManager): string {
  const header = manager.getHeader();
  if (!header) throw new Error("Forked session is missing its header");
  return [header, ...manager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
}

function validateSessionFile(sessionFile: string, sessionDir: string, expectedSessionId: string): void {
  const reopened = SessionManager.open(sessionFile, sessionDir);
  if (reopened.getSessionId() !== expectedSessionId) {
    throw new Error("Forked session ID changed after persistence");
  }
}

/** 发布失败不取得最终路径所有权；发布成功后的校验失败才回滚目标。 */
function publishValidatedSession(
  content: string,
  finalSessionFile: string,
  sessionDir: string,
  expectedSessionId: string,
): void {
  writePrivateFileCreateAtomicSync(finalSessionFile, content);
  try {
    validateSessionFile(finalSessionFile, sessionDir, expectedSessionId);
  } catch (error) {
    try {
      unlinkSync(finalSessionFile);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

/**
 * 创建独立会话文件。成功返回时文件一定已落盘且可用相同 ID 立即重新打开。
 * 此服务不修改运行中的 AgentSession，也不处理前端草稿。
 */
export function createForkedSession(sourceSessionFile: string, entryId: string): ForkedSession {
  const sourceManager = SessionManager.open(sourceSessionFile);
  const entries = sourceManager.getEntries();
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry || !isMessageEntry(entry)) throw new Error("Invalid message entry ID for forking");

  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") {
    throw new Error("Only user or assistant messages can be forked");
  }

  const sessionDir = sourceManager.getSessionDir();
  const stagingDir = mkdtempSync(join(sessionDir, ".pi-web-fork-"));
  let prepared: { content: string; fileName: string; sessionId: string };
  try {
    let forkedManager: SessionManager;
    let stagedSessionFile: string;

    if (role === "user" && !entry.parentId) {
      forkedManager = SessionManager.create(sourceManager.getCwd(), stagingDir);
      const path = forkedManager.newSession({ parentSession: sourceSessionFile });
      if (!path) throw new Error("Failed to create an empty forked session");
      stagedSessionFile = path;
    } else {
      const leafId = role === "user"
        ? entry.parentId!
        : resolveAssistantLeaf(entry, entries);
      // SDK 只能以替换语义写分支，先限制在唯一暂存目录，避免触碰真实会话路径。
      forkedManager = SessionManager.open(sourceSessionFile, stagingDir);
      const path = forkedManager.createBranchedSession(leafId);
      if (!path) throw new Error("Failed to create forked session");
      stagedSessionFile = path;
    }

    const sessionId = forkedManager.getSessionId();
    if (!existsSync(stagedSessionFile)) {
      writePrivateFileCreateAtomicSync(stagedSessionFile, serializeSession(forkedManager));
    }
    validateSessionFile(stagedSessionFile, stagingDir, sessionId);
    prepared = {
      content: readFileSync(stagedSessionFile, "utf8"),
      fileName: basename(stagedSessionFile),
      sessionId,
    };
  } finally {
    // Commit 前完成所有暂存清理；此后不再执行可能覆盖成功返回的资源清理。
    rmSync(stagingDir, { recursive: true, force: true });
  }

  const newSessionFile = join(sessionDir, prepared.fileName);
  publishValidatedSession(prepared.content, newSessionFile, sessionDir, prepared.sessionId);
  return { newSessionId: prepared.sessionId, newSessionFile };
}
