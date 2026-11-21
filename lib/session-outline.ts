import { getTurnAnchors, splitFinalAssistantBlocks } from "./message-display";
import { normalizeAssistantMessage } from "./normalize";
import { hasOutlineFinalAnswer, pickOutlineFinalAssistant } from "./outline-final-answer";
import { extractOutlineHeadings, joinAnswerBlocks, outlineHeadingsFromBlocks, scanOutlineLines, stripInlineMarkdown } from "./outline-headings";
import { readIndexedBranchOutlineRecords, readIndexedOutlineIdentity } from "./session-content-index";
import { turnAnchorShape } from "./session-turns";
import { isWakeMessageType } from "./wake-message-types";
import type { AssistantMessage, SessionEntry, TextContent } from "./types";

import type { OutlineHeading, SessionOutlineTurn } from "./session-outline-types";
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
    const customType = typeof entry.customType === "string" ? entry.customType : undefined;
    return {
      kind: "custom",
      customType,
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

/** 最终回答的文本块（按正文渲染顺序）。保留原始缩进：四空格缩进的围栏是缩进代码。 */
function extractFinalAssistantBlocks(entry: SessionEntry | null): string[] {
  if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") return [];
  if (!Array.isArray(entry.message.content)) return [];
  const normalized = normalizeAssistantMessage(entry.message) as AssistantMessage;
  const { answerBlocks } = splitFinalAssistantBlocks(normalized);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text);
}

function extractFinalAssistantMarkdown(entry: SessionEntry | null): string {
  const markdown = joinAnswerBlocks(extractFinalAssistantBlocks(entry));
  return markdown.trim() ? markdown : "";
}

/**
 * 逐块取标题，和正文、右侧大纲预览同一套口径（共用 `outlineHeadingsFromBlocks`）。
 *
 * 拼接后再扫会把后一块的两格缩进标题并进前一块的列表（`joinAnswerBlocks` 用空行拼接，
 * 而列表项内容可以跨空行延续），服务端会给未加载轮次少算一个标题，与已加载轮次对不上。
 */
function extractFinalAssistantHeadings(entry: SessionEntry | null): OutlineHeading[] {
  return outlineHeadingsFromBlocks(extractFinalAssistantBlocks(entry), MAX_HEADINGS_PER_TURN);
}

/**
 * 这一轮该不该出现在大纲里。
 *
 * 后台命令、定时任务的唤醒消息也会开一轮（它们带 `display: true` 并锚定新轮次），但那不是
 * 用户提问：把这些行铺进大纲只会把真正的问题挤下去。过滤放在配对**之后**——配对仍然按
 * 原始锚点逐轮算 `finalAssistant`，否则被跳过那一轮的回答会算到上一个用户提问头上。
 * 轮次编号保留原值（会有空号），和正文里的轮次分组对得上。
 */
export function isOutlineUserTurn(customType: string | undefined): boolean {
  return !isWakeMessageType(customType);
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
      headings: extractFinalAssistantHeadings(finalAssistant),
    };
  }).filter((turn) => isOutlineUserTurn(turn.customType));
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
  // 环检测：文件被改坏（自己当自己的祖先）时不能原地打转。
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const shape = turnAnchorShape(cursor);
    if (shape) branch.push({ entry: cursor, shape });
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();
  const anchors = getTurnAnchors(branch.map((item) => item.shape));
  const pairs: Array<{ turnNumber: number; anchor: SessionEntry; finalAssistant: SessionEntry | null }> = [];
  for (let i = 0; i < branch.length; i += 1) {
    if (!anchors[i]) continue;
    // 与磁盘索引共用同一套挑选规则：取本轮最后一条「有可展示回答」的助手记录；
    // 末尾只剩工具调用或空中止（stopReason/空 content）时一直往前找，和主对话一样
    // 不设上限，否则运行中的会话和空闲后读磁盘会给出不同的摘要与标题。
    const assistants: SessionEntry[] = [];
    let j = i + 1;
    while (j < branch.length && !anchors[j]) {
      if (branch[j].shape.role === "assistant") assistants.push(branch[j].entry);
      j += 1;
    }
    const finalAssistant = pickOutlineFinalAssistant(assistants, hasOutlineFinalAnswer);
    pairs.push({ turnNumber: pairs.length + 1, anchor: branch[i].entry, finalAssistant });
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
