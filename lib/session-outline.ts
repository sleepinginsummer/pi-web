import { getTurnAnchors, splitFinalAssistantBlocks } from "./message-display";
import { normalizeAssistantMessage } from "./normalize";
import { hasOutlineFinalAnswer } from "./outline-final-answer";
import { extractOutlineHeadings, scanOutlineLines, stripInlineMarkdown } from "./outline-headings";
import { readIndexedBranchOutlineRecords, readIndexedOutlineIdentity } from "./session-content-index";
import { turnAnchorShape } from "./session-turns";
import type { AssistantMessage, SessionEntry, TextContent } from "./types";

import type { SessionOutlineTurn } from "./session-outline-types";
export type { OutlineHeading, SessionOutlineTurn } from "./session-outline-types";
export { extractOutlineHeadings } from "./outline-headings";

export interface SessionOutlineResult {
  leafId: string | null;
  version: string;
  turns: SessionOutlineTurn[];
}

const MAX_USER_TEXT_CHARS = 280;
const MAX_SUMMARY_CHARS = 220;
const MAX_HEADINGS_PER_TURN = 16;
const MAX_CACHED_OUTLINES = 32;

declare global {
  var __piSessionOutlines: Map<string, SessionOutlineResult> | undefined;
}

function outlineCache(): Map<string, SessionOutlineResult> {
  globalThis.__piSessionOutlines ??= new Map();
  return globalThis.__piSessionOutlines;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

/** 提取最终回答的纯文本摘要，用于 2-B 未加载旧轮次在大纲内的轻量预览。 */
export function extractOutlineSummary(markdown: string, maxChars = MAX_SUMMARY_CHARS): string {
  if (!markdown) return "";
  const lines: string[] = [];
  for (const line of scanOutlineLines(markdown)) {
    if (line.kind === "heading") continue;
    const trimmed = line.text;
    // 三级及更深标题在这里仍是正文：摘要只留第一句，不要被标题词占满。
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^[-*_]{3,}$/.test(trimmed)) continue;
    const cleaned = stripInlineMarkdown(trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s*/, ""));
    if (!cleaned) continue;
    lines.push(cleaned);
    if (lines.join(" ").length >= maxChars + 20) break;
  }
  if (lines.length === 0) {
    const fallback = extractOutlineHeadings(markdown).map((heading) => heading.text).join(" · ");
    return truncateText(fallback, maxChars);
  }
  return truncateText(lines.join(" "), maxChars);
}

function extractEntryAnchorText(entry: SessionEntry): {
  kind: "user" | "custom" | "compaction";
  customType?: string;
  hiddenAnchor?: boolean;
  text: string;
} {
  if (entry.type === "compaction") {
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    return {
      kind: "compaction",
      customType: "compaction",
      text: truncateText(stripInlineMarkdown(summary.split("\n")[0] ?? ""), MAX_USER_TEXT_CHARS),
    };
  }
  if (entry.type === "branch_summary") {
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    return {
      kind: "user",
      text: truncateText(summary, MAX_USER_TEXT_CHARS),
    };
  }
  if (entry.type === "custom_message") {
    const raw = entry.content;
    let text = "";
    if (typeof raw === "string") text = raw;
    else if (Array.isArray(raw)) {
      text = raw
        .filter((block): block is TextContent => Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"))
        .map((block) => block.text)
        .join("\n");
    }
    const hiddenAnchor = entry.display !== true;
    return {
      kind: "custom",
      customType: typeof entry.customType === "string" ? entry.customType : undefined,
      ...(hiddenAnchor ? { hiddenAnchor: true } : {}),
      text: truncateText(text, MAX_USER_TEXT_CHARS),
    };
  }
  if (entry.type === "message" && entry.message && "content" in entry.message) {
    const message = entry.message;
    const content = message.content;
    if (typeof content === "string") {
      return { kind: "user", text: truncateText(content, MAX_USER_TEXT_CHARS) };
    }
    if (Array.isArray(content)) {
      const text = (content as readonly { type?: unknown; text?: unknown }[])
        .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      return { kind: "user", text: truncateText(text, MAX_USER_TEXT_CHARS) };
    }
  }
  return { kind: "user", text: "" };
}

function extractFinalAssistantMarkdown(entry: SessionEntry | null): string {
  if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") return "";
  if (!Array.isArray(entry.message.content)) return "";
  const normalized = normalizeAssistantMessage(entry.message) as AssistantMessage;
  const { answerBlocks } = splitFinalAssistantBlocks(normalized);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

export function buildOutlineTurnsFromPairs(
  pairs: ReadonlyArray<{ turnNumber: number; anchor: SessionEntry; finalAssistant: SessionEntry | null }>,
): SessionOutlineTurn[] {
  return pairs.map(({ turnNumber, anchor, finalAssistant }) => {
    const anchorInfo = extractEntryAnchorText(anchor);
    const answerMarkdown = extractFinalAssistantMarkdown(finalAssistant);
    return {
      turnNumber,
      entryId: anchor.id,
      kind: anchorInfo.kind,
      ...(anchorInfo.customType ? { customType: anchorInfo.customType } : {}),
      ...(anchorInfo.hiddenAnchor ? { hiddenAnchor: true } : {}),
      userText: anchorInfo.text,
      ...(finalAssistant ? { finalAssistantEntryId: finalAssistant.id } : {}),
      answerSummary: extractOutlineSummary(answerMarkdown),
      headings: extractOutlineHeadings(answerMarkdown, MAX_HEADINGS_PER_TURN),
    };
  });
}

/** 从内存中的完整 SessionEntry 列表（运行中 live 会话）构建活动分支全量大纲。 */
export function buildSessionOutlineFromEntries(
  entries: readonly SessionEntry[],
  leafId?: string | null,
): { leafId: string | null; turns: SessionOutlineTurn[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activeLeafId = leafId ?? entries.at(-1)?.id ?? null;
  const branch: Array<{ entry: SessionEntry; shape: NonNullable<ReturnType<typeof turnAnchorShape>> }> = [];
  let cursor = byId.get(activeLeafId ?? "");
  while (cursor) {
    const shape = turnAnchorShape(cursor);
    if (shape) branch.push({ entry: cursor, shape });
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();
  const anchors = getTurnAnchors(branch.map((item) => item.shape));
  const pairs: Array<{ turnNumber: number; anchor: SessionEntry; finalAssistant: SessionEntry | null }> = [];
  for (let i = 0; i < branch.length; i += 1) {
    if (!anchors[i]) continue;
    // 与主对话一致：取本轮最后一条「有可展示回答」的助手记录。
    // 末尾若只剩工具调用或空中止（stopReason/空 content），回退到上一条真实回答，
    // 否则这一轮的摘要和标题会被那条空记录抹掉。
    let finalAssistant: SessionEntry | null = null;
    let lastAssistant: SessionEntry | null = null;
    let j = i + 1;
    while (j < branch.length && !anchors[j]) {
      const entry = branch[j].entry;
      if (branch[j].shape.role === "assistant") {
        lastAssistant = entry;
        if (hasOutlineFinalAnswer(entry)) finalAssistant = entry;
      }
      j += 1;
    }
    pairs.push({ turnNumber: pairs.length + 1, anchor: branch[i].entry, finalAssistant: finalAssistant ?? lastAssistant });
  }
  return { leafId: activeLeafId, turns: buildOutlineTurnsFromPairs(pairs) };
}


/** 从磁盘内容索引读取活动分支全量大纲，按文件版本和 leaf 缓存。 */
export async function readIndexedSessionOutline(
  filePath: string,
  leafId?: string,
): Promise<SessionOutlineResult> {
  // 先只取索引的身份（已按文件签名缓存），命中大纲缓存时不必再逐条读记录。
  const identity = await readIndexedOutlineIdentity(filePath, leafId);
  const cacheKey = `${filePath}:${identity.version}:${identity.leafId ?? ""}`;
  const cached = outlineCache().get(cacheKey);
  if (cached) return cached;

  const slice = await readIndexedBranchOutlineRecords(filePath, leafId);
  const result: SessionOutlineResult = {
    leafId: slice.leafId,
    version: slice.version,
    turns: buildOutlineTurnsFromPairs(slice.turns),
  };
  const cache = outlineCache();
  cache.set(cacheKey, result);
  if (cache.size > MAX_CACHED_OUTLINES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return result;
}

export function resetSessionOutlinesForTests(): void {
  globalThis.__piSessionOutlines = undefined;
}
