import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";

// Kept as literals: this module imports nothing at run time, so its test loads
// it with Node's type stripping alone. Canonical definitions: session-family.ts.
const SIDE_BOUNDARY_MESSAGE_TYPE = "pi-web:side-boundary";
const SIDE_SESSION_NAME = "Side chat";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  /** A title hit has no message entry to reveal. */
  titleMatch?: boolean;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

// Whitespace separates terms and every term must appear somewhere in the session; a
// double-quoted run stays one exact phrase. A quote opens a phrase only at the start of
// a term, so `foo"bar` stays literal; an unclosed quote reads to the end of the query.
function parseTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query) {
    if (char === '"' && (quoted || !current)) {
      if (quoted && current) terms.push(current);
      if (quoted) current = "";
      quoted = !quoted;
    } else if (!quoted && /\s/.test(char)) {
      if (current) terms.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) terms.push(current);
  return terms;
}

// ponytail: scan recent files without an index; add indexing if measured latency warrants it.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // A query of nothing but quotes (`""`) holds no term: search it as one literal string.
  const terms = parseTerms(needle);
  // Escape every operator: each term is literal, with offsets in the original text.
  const uniqueTerms = [...new Set(terms.length ? terms : [needle])];
  const matchers = uniqueTerms
    .map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  /*
   * 粗筛：大块工具输出不该进 JSON.parse。
   *
   * 结构字段可以在原始行上判——每一轮都必须给出 user/assistant 的消息角色，
   * `"role":"toolResult"` 这类大行直接跳过。关键词**只**用来排除：术语里不含
   * JSON 会转义的字符（引号、反斜杠、控制字符）时，解码后的正文里出现它，原始行
   * 里就一定有它；反过来不成立（`\u0068` 形式的转义），所以带 `\u` 的行照旧解析。
   * 大小写不敏感和 matcher 一致，免得「排除」比「命中」更严。
   */
  const RAW_SAFE_TERM = /^[^"\\\u0000-\u001f]+$/;
  const rawTermTests = uniqueTerms
    .filter((term) => RAW_SAFE_TERM.test(term))
    .map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  // 每个词都能在原始行上判，才敢按「一个都没有」排除；有词带引号/反斜杠时就整行解析。
  const rawFilterable = rawTermTests.length > 0 && rawTermTests.length === uniqueTerms.length;
  const MESSAGE_ROLE = /"role"\s*:\s*"(?:user|assistant)"/;
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const sessionIds = new Set(sessions.map((session) => session.id));
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    // A side chat whose parent is gone has no family row in the sidebar either:
    // a hit here could not be opened.
    .filter((session) => session.relation?.kind !== "side" || sessionIds.has(session.relation.parentSessionId))
    .sort((a, b) => b.modified.localeCompare(a.modified));

  for (const [index, session] of candidates.entries()) {
    if (index >= MAX_FILES || response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const stream = createReadStream(session.path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let found = false;
    // The row shows the first term's first hit; the other terms only have to appear somewhere.
    let hit: SessionSearchResult | undefined;
    let pending = matchers.slice(1);
    // A side chat copies its parent's whole text: only what follows the boundary
    // message is its own. Other sessions have no boundary and search everything.
    let pastBoundary = session.relation?.kind !== "side";
    try {
      for await (const line of lines) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        // Before the boundary only the boundary line itself matters: inherited
        // lines are dropped before parsing, so a prefix that never mentions the
        // boundary type costs reads only.
        if (!pastBoundary && !line.includes(SIDE_BOUNDARY_MESSAGE_TYPE)) continue;
        if (line.length > MAX_LINE_CHARS) {
          response.truncated = true;
          continue;
        }
        /*
         * 粗筛只在边界之后做：边界那一行本身要解析（它负责把 pastBoundary 打开），
         * 在它之前跳过任何一行都可能永远打不开，后面的正文就全丢了。
         *
         * 结构：只有 user/assistant 消息可能命中，工具结果和自定义记录直接丢。
         * 关键词：没有 `\u` 转义、连一个词都没出现在原始行里时，这一行既不可能命中，
         * 也不可能满足别的词（多词查询里各词可以落在不同行上）。
         */
        if (pastBoundary) {
          if (!MESSAGE_ROLE.test(line)) continue;
          if (rawFilterable && !line.includes("\\u") && !rawTermTests.some((test) => test.test(line))) continue;
        }
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        // The boundary itself is boilerplate, never a hit; everything before it
        // is inherited and already searchable in the parent session.
        if (entry?.type === "custom_message" && entry?.customType === SIDE_BOUNDARY_MESSAGE_TYPE) {
          pastBoundary = true;
          continue;
        }
        if (!pastBoundary) continue;
        if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
        const content: unknown = entry.message.content;
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
        const text = textBlocks.map((block) => block.text).join("\n");
        pending = pending.filter((matcher) => !matcher.test(text));
        const match = hit ? null : matchers[0].exec(text);
        if (!match) {
          if (hit && !pending.length) break;
          continue;
        }
        const start = match.index;
        const end = start + match[0].length;
        let blockOffset = 0;
        const matchedBlock = textBlocks.find((block) => {
          const blockEnd = blockOffset + block.text.length;
          blockOffset = blockEnd + 1;
          return start <= blockEnd;
        });
        hit = {
          session,
          ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
          blockIndex: matchedBlock!.blockIndex,
          before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
          match: match[0].replace(/\s+/g, " "),
          after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
        };
        if (!pending.length) break;
      }
    } catch {
      // Missing/unreadable files and interrupted reads must not hide other results.
      response.truncated = true;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (hit && !pending.length) {
      response.results.push(hit);
      found = true;
    }
    if (!found && stream.bytesRead >= MAX_FILE_BYTES) response.truncated = true;
    // Preserve message navigation when both body and title match. The catalogue
    // already carries the displayed name (including session_info names), so a
    // title hit is a fallback only when the transcript has no match.
    if (!found && pastBoundary && !signal.aborted && Date.now() < deadline) {
      // A side chat's firstMessage is its inherited first question, and its name
      // may still be the app's placeholder: neither stands in for a title hit.
      const title = session.relation?.kind === "side"
        ? (session.name && session.name !== SIDE_SESSION_NAME ? session.name : "")
        : session.name || session.firstMessage || "";
      // Every term has to be in the title too: half the terms there and half in the body is no hit.
      const titleHit = matchers.every((matcher) => matcher.test(title)) ? matchers[0].exec(title) : null;
      if (titleHit) {
        response.results.push({
          session,
          blockIndex: 0,
          titleMatch: true,
          before: title.slice(0, titleHit.index),
          match: titleHit[0],
          after: title.slice(titleHit.index + titleHit[0].length),
        });
      }
    }
  }
  return response;
}
