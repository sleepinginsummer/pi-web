import type { NestedToolCallRecord, NestedToolCalls } from "@earendil-works/pi-ai";
import type { AgentMessage, AssistantContentBlock, SessionEntry, ToolCallContent, ToolResultMessage } from "./types";
import { resolveLocalFilePath } from "./file-links";
import { normalizeToolCalls } from "./normalize";
import { getFileName } from "./file-paths";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "./tool-names";
import {
  applyPatchPreviewToFiles,
  applyPatchResultHasFailures,
  getApplyPatchAppliedFiles,
  getApplyPatchInputText,
  parseApplyPatchInput,
} from "./apply-patch";

export type SessionArtifactKind = "web" | "doc" | "html" | "image" | "json" | "file";

export interface SessionArtifact {
  /** 稳定唯一键（网页产物按 artifactId，本地文件按解析后的绝对路径）。 */
  id: string;
  kind: SessionArtifactKind;
  name: string;
  /** 本地绝对路径，或网页产物的预览 URL。 */
  path: string;
  /** 网页产物对应的本地源文件路径（可选）。 */
  sourcePath?: string;
  artifactId?: string;
  version?: number;
  timestamp?: number;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const HTML_EXTS = new Set(["html", "htm"]);
const DOC_EXTS = new Set(["md", "mdx", "txt", "pdf", "doc", "docx", "csv", "tsv", "mmd", "mermaid", "rtf"]);
const JSON_EXTS = new Set(["json", "jsonl", "yaml", "yml", "toml", "xml"]);

function inferArtifactKind(filePath: string): SessionArtifactKind {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (HTML_EXTS.has(ext)) return "html";
  if (DOC_EXTS.has(ext)) return "doc";
  if (JSON_EXTS.has(ext)) return "json";
  return "file";
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readResultText(result: ToolResultMessage): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function isPublishArtifactCall(block: ToolCallContent): { isPublish: boolean; input: Record<string, unknown> | undefined } {
  const name = block.toolName.toLowerCase();
  if (name.includes("publish_artifact")) {
    return { isPublish: true, input: block.input };
  }
  if ((name === "mcp" || name.endsWith("_mcp") || name.includes("magpie_artifacts")) && block.input) {
    const innerTool = typeof block.input.tool === "string" ? block.input.tool.toLowerCase() : "";
    if (innerTool.includes("publish_artifact")) {
      const rawArgs = block.input.args;
      if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        return { isPublish: true, input: rawArgs as Record<string, unknown> };
      }
      if (typeof rawArgs === "string") {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { isPublish: true, input: parsed as Record<string, unknown> };
          }
        } catch {
          return { isPublish: true, input: undefined };
        }
      }
      return { isPublish: true, input: undefined };
    }
  }
  return { isPublish: false, input: undefined };
}

function extractPublishedWebArtifact(
  input: Record<string, unknown> | undefined,
  result: ToolResultMessage,
  cwd: string | undefined,
  timestamp: number | undefined,
): SessionArtifact | null {
  const text = readResultText(result);
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\/a\/([a-z0-9]+)\/?/i);
  if (!urlMatch) return null;

  const url = urlMatch[0];
  const idMatch = text.match(/\bid:\s*([a-z0-9]+)/i);
  const artifactId = idMatch?.[1] ?? urlMatch[1];
  const versionMatch = text.match(/\bversion\s+(\d+)/i);
  const version = versionMatch ? Number(versionMatch[1]) : undefined;
  const quotedTitle = text.match(/Published(?:\s+version\s+\d+\s+of)?\s+"([^"]+)"/i)?.[1];
  const inputTitle = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : undefined;
  const rawSource = typeof input?.file_path === "string" && input.file_path.trim() ? input.file_path.trim() : undefined;
  const sourcePath = rawSource ? (resolveLocalFilePath(rawSource, cwd) ?? rawSource) : undefined;
  const baseName = quotedTitle ?? inputTitle ?? (sourcePath ? getFileName(sourcePath) : artifactId);
  const name = version && version > 1 ? `${baseName} (v${version})` : baseName;

  return {
    id: `web:${artifactId}`,
    kind: "web",
    name,
    path: url,
    sourcePath,
    artifactId,
    version,
    timestamp,
  };
}

/** 仅提取 apply_patch 中“新建”的文件路径，避免与 Git 变更列表里的零碎代码编辑高度重复。 */
function readApplyPatchAddedPaths(
  input: Record<string, unknown> | undefined,
  result: ToolResultMessage,
): string[] {
  const details = result.details;
  if (applyPatchResultHasFailures(details)) return [];

  const added = new Set<string>();
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const preview = (details as Record<string, unknown>).preview;
    if (preview && typeof preview === "object" && !Array.isArray(preview)) {
      const files = (preview as Record<string, unknown>).files;
      if (Array.isArray(files)) {
        for (const raw of files) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const entry = raw as { operation?: unknown; filePath?: unknown };
          if (entry.operation === "add" && typeof entry.filePath === "string" && entry.filePath.length > 0) {
            added.add(entry.filePath);
          }
        }
      }
    }
  }
  for (const match of getApplyPatchInputText(input).matchAll(/^\*\*\* Add File: (.+)$/gm)) {
    const filePath = (match[1] ?? "").trim();
    if (filePath) added.add(filePath);
  }
  if (added.size > 0) return Array.from(added);

  // 兜底：若 preview/input 未显式标 Add，则不把普通修改纳入产物。
  const applied = getApplyPatchAppliedFiles(details);
  if (applied && applied.length > 0) return [];
  const previewFiles = details && typeof details === "object" && !Array.isArray(details)
    ? applyPatchPreviewToFiles((details as Record<string, unknown>).preview)
    : null;
  const parsed = previewFiles ?? parseApplyPatchInput(getApplyPatchInputText(input));
  if (!parsed) return [];
  return parsed
    .filter((f) => !f.oldPath && Boolean(f.newPath))
    .map((f) => f.newPath!)
    .filter(Boolean);
}

function readCodemodeWrittenPaths(result: ToolResultMessage): string[] {
  const nestedCalls = (result as unknown as { nestedCalls?: Partial<NestedToolCalls> }).nestedCalls?.calls;
  if (!Array.isArray(nestedCalls)) return [];
  const paths: string[] = [];
  for (const call of nestedCalls) {
    if (!call || typeof call !== "object" || Array.isArray(call)) continue;
    const record = call as Partial<NestedToolCallRecord>;
    // 严格按 SDK 协议：仅纳入明确执行成功的嵌套写入，排除 error、unfinished 与缺失 status 的记录
    if (record.status !== "ok") continue;
    if (typeof record.name !== "string" || !isWriteToolName(record.name)) continue;
    if (record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)) {
      const p = readToolPath(record.arguments as Record<string, unknown>);
      if (p) paths.push(p);
    }
  }
  return paths;
}

/**
 * 聚合当前会话中 AI 成功生成/发布的产物列表（按最后一次生成倒序排列、去重）。
 *
 * 来源仅限已返回且无错误的真实工具调用：
 * 1. `write` 类文件写入工具与 `apply_patch` 新建文件；
 * 2. `codemode` 嵌套调用的 `write` 工具；
 * 3. `magpie-artifacts` 的 `publish_artifact` 网页产物（同一 artifactId 合并保留最新版本）。
 */
export function collectSessionArtifacts(
  messages: readonly AgentMessage[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
  hiddenIds?: ReadonlySet<string>,
): SessionArtifact[] {
  // 使用 Map 保持按最近一次更新排序（重新写入同一产物时删旧插新，最后反转即可）
  const ordered = new Map<string, SessionArtifact>();

  const upsert = (artifact: SessionArtifact) => {
    if (hiddenIds?.has(artifact.id) || hiddenIds?.has(artifact.path)) return;
    ordered.delete(artifact.id);
    ordered.set(artifact.id, artifact);
  };

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const msgTimestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

    for (const block of message.content as AssistantContentBlock[]) {
      if (block.type !== "toolCall") continue;
      const result = toolResults?.get(block.toolCallId);
      if (!result || result.isError) continue;
      const ts = typeof result.timestamp === "number" ? result.timestamp : msgTimestamp;

      // 1. 网页产物（magpie-artifacts）
      const publishInfo = isPublishArtifactCall(block);
      if (publishInfo.isPublish) {
        const webArtifact = extractPublishedWebArtifact(publishInfo.input, result, cwd, ts);
        if (webArtifact) {
          upsert(webArtifact);
        }
        continue;
      }

      // 2. write / apply_patch 新建 / codemode 嵌套 write
      let rawPaths: string[] = [];
      if (isWriteToolName(block.toolName)) {
        const p = readToolPath(block.input);
        if (p) rawPaths = [p];
      } else if (isApplyPatchToolName(block.toolName)) {
        rawPaths = readApplyPatchAddedPaths(block.input, result);
      } else {
        rawPaths = readCodemodeWrittenPaths(result);
      }

      for (const rawPath of rawPaths) {
        const resolved = resolveLocalFilePath(rawPath, cwd);
        if (!resolved) continue;
        upsert({
          id: `file:${resolved}`,
          kind: inferArtifactKind(resolved),
          name: getFileName(resolved),
          path: resolved,
          timestamp: ts,
        });
      }
    }
  }

  return Array.from(ordered.values()).reverse();
}


/**
 * 直接从会话原始条目（SessionEntry[]）聚合成功产出的产物。
 * 供服务端删除授权核验与存在性查询复用，确保前后端产物口径完全一致。
 */
export function collectSessionArtifactsFromEntries(
  entries: readonly SessionEntry[],
  cwd?: string,
  hiddenIds?: ReadonlySet<string>,
): SessionArtifact[] {
  const messages: AgentMessage[] = [];
  const toolResults = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "assistant") {
      // 复用 normalizeToolCalls，将 SDK 原始 toolCall（id/name/arguments）归一为统一结构
      messages.push(normalizeToolCalls(msg));
    } else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      toolResults.set(msg.toolCallId, msg as ToolResultMessage);
    }
  }
  return collectSessionArtifacts(messages, toolResults, cwd, hiddenIds);
}


/**
 * 在工具执行完成时提取本次写入的本地文件绝对路径，供服务端在写入时刻绑定真实目标路径。
 */
export function extractWrittenPathsFromToolExecution(
  toolName: string,
  input: unknown,
  result: unknown,
  cwd?: string,
): string[] {
  const inputRecord = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const resultMsg = (result && typeof result === "object" && !Array.isArray(result)
    ? result
    : {}) as ToolResultMessage;

  let rawPaths: string[] = [];
  if (isWriteToolName(toolName)) {
    const p = readToolPath(inputRecord);
    if (p) rawPaths = [p];
  } else if (isApplyPatchToolName(toolName)) {
    rawPaths = readApplyPatchAddedPaths(inputRecord, resultMsg);
  } else {
    rawPaths = readCodemodeWrittenPaths(resultMsg);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of rawPaths) {
    const abs = resolveLocalFilePath(rawPath, cwd);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    resolved.push(abs);
  }
  return resolved;
}


const EXTRA_MUTATION_TOOL_NAMES = new Set(["insert", "copy", "move", "undo_last_change"]);

/** 判断工具是否会修改工作区文件（用于识别等行数编辑等不会改变 Git 增删统计的真实修改）。 */
export function isFileMutationToolName(toolName: string): boolean {
  if (isWriteToolName(toolName) || isEditToolName(toolName) || isApplyPatchToolName(toolName)) {
    return true;
  }
  const lower = toolName.toLowerCase();
  if (EXTRA_MUTATION_TOOL_NAMES.has(lower)) return true;
  for (const suffix of EXTRA_MUTATION_TOOL_NAMES) {
    if (lower.endsWith(`.${suffix}`) || lower.endsWith(`_${suffix}`)) return true;
  }
  return false;
}

/**
 * 统计当前会话内已成功执行的文件写入/编辑次数（含 codemode 内 `status === "ok"` 的嵌套文件写入/编辑）。
 * 用于在已有脏文件被等行数修改（Git 增删统计不变）时仍能准确感知本会话的文件修改活动。
 */
export function countSessionFileMutations(
  messages: readonly AgentMessage[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as AssistantContentBlock[]) {
      if (block.type !== "toolCall") continue;
      const result = toolResults?.get(block.toolCallId);
      if (!result) continue;
      if (isFileMutationToolName(block.toolName)) {
        if (!result.isError) count += 1;
        continue;
      }
      // 外层 codemode 失败或抛错时，此前已完成的 status === "ok" 嵌套编辑已经落盘且不会回滚，仍须逐项统计
      const nestedCalls = (result as unknown as { nestedCalls?: Partial<NestedToolCalls> }).nestedCalls?.calls;
      if (!Array.isArray(nestedCalls)) continue;
      for (const call of nestedCalls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) continue;
        const record = call as Partial<NestedToolCallRecord>;
        if (record.status === "ok" && typeof record.name === "string" && isFileMutationToolName(record.name)) {
          count += 1;
        }
      }
    }
  }
  return count;
}


const HIDDEN_ARTIFACTS_KEY_PREFIX = "pi-web:hidden-artifacts:";

/** 从浏览器持久化存储读取某会话手动隐藏的产物 ID 集合。 */
export function loadHiddenArtifactIds(sessionId: string | null | undefined): Set<string> {
  if (!sessionId || typeof window === "undefined") return new Set();
  try {
    const stored = window.localStorage.getItem(`${HIDDEN_ARTIFACTS_KEY_PREFIX}${sessionId}`);
    const parsed = stored ? JSON.parse(stored) as unknown : null;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** 将某会话手动隐藏的产物 ID 集合写入浏览器持久化存储。 */
export function saveHiddenArtifactIds(sessionId: string | null | undefined, ids: ReadonlySet<string>): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${HIDDEN_ARTIFACTS_KEY_PREFIX}${sessionId}`, JSON.stringify(Array.from(ids)));
  } catch {
    // 浏览器存储受限时忽略持久化失败
  }
}
