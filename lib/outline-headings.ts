import type { OutlineHeading } from "./session-outline-types";

/**
 * Markdown 大纲行扫描：把一段最终回答拆成「一/二级标题」与「正文行」。
 *
 * 服务端的大纲接口和前端大纲面板共用这一份实现，避免两边对同一段文字
 * 得出不同结论。ATX（`#` / `##`）与 Setext（`===` / `---` 下划线）两种
 * 写法都算标题；围栏代码块里的 `#` 注释是代码，不算标题。
 */

export type OutlineLine =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "text"; text: string };

/** Setext 下划线：`===` 是一级，`---` 是二级（缩进不超过三个空格）。 */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const ATX_HEADING = /^ {0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** 关闭围栏整行只有围栏字符（后面只允许空白）：` ```~~~ ` 是代码内容，不是关闭行。 */
const CLOSING_FENCE = /^ {0,3}([`~]+)[ \t]*$/;

/**
 * 这一行能否关闭当前围栏。
 *
 * CommonMark 要求关闭围栏与开启同字符、长度不短于开启，并且整行只有这个字符——
 * 混入另一种围栏字符（例如开 ``` 之后的 ```~~~）只是代码内容。扫描器和拼接器
 * 都要按这条规则算，否则正文里可见的标题会被当成代码，大纲和正文对不上。
 */
function closesFence(line: string, open: { char: string; length: number }): boolean {
  const match = line.match(CLOSING_FENCE);
  if (!match) return false;
  const marker = match[1];
  return marker.length >= open.length && marker === open.char.repeat(marker.length);
}

/**
 * 能作为 Setext 标题正文的行：普通段落文字。
 * 空行、列表项、引用、缩进代码、表格行、分隔线和 HTML 块都不能当标题。
 */
function isSetextTextLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (/^(?:[-*+]|\d+[.)])[ \t]/.test(trimmed)) return false;
  if (/^>/.test(trimmed)) return false;
  if (/^\|/.test(trimmed)) return false;
  if (/^(?:[-*_])(?:[ \t]*[-*_]){2,}$/.test(trimmed)) return false;
  if (/^<\/?[a-zA-Z][^>]*>/.test(trimmed)) return false;
  return true;
}

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // 强调符只在成对且贴着文字时去掉：词内下划线（snake_case）和乘号（5 * 3 * 2）都是正文，
    // 而 CommonMark 本身也不允许词内 `_` 做强调。下划线用前一个字符做边界，避免依赖 lookbehind。
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, "$1$2")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 逐行扫描 Markdown，按出现顺序返回标题行与正文行（代码块整体跳过）。 */
export function scanOutlineLines(markdown: string): OutlineLine[] {
  if (!markdown) return [];
  const lines: OutlineLine[] = [];
  let inFence: { char: string; length: number } | null = null;
  // 上一行正文：下一行若是 Setext 下划线，它其实是标题文字。
  let pending: string | null = null;

  const flush = () => {
    if (pending !== null) lines.push({ kind: "text", text: pending });
    pending = null;
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const fenceMatch = rawLine.match(FENCE);
    if (fenceMatch) {
      if (!inFence) {
        flush();
        inFence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (closesFence(rawLine, inFence)) {
        inFence = null;
      }
      // 围栏里混入另一种围栏字符的行是代码内容：既不是关闭行，也不参与正文扫描。
      continue;
    }
    if (inFence) continue;

    const setext = rawLine.match(SETEXT_UNDERLINE);
    if (setext && pending !== null) {
      if (isSetextTextLine(pending)) {
        const text = stripInlineMarkdown(pending);
        if (text) lines.push({ kind: "heading", level: setext[1][0] === "=" ? 1 : 2, text });
      } else {
        lines.push({ kind: "text", text: pending });
      }
      pending = null;
      continue;
    }

    const atx = rawLine.match(ATX_HEADING);
    if (atx) {
      flush();
      const text = stripInlineMarkdown(atx[2]);
      if (text) lines.push({ kind: "heading", level: atx[1].length === 1 ? 1 : 2, text });
      continue;
    }

    flush();
    const trimmed = rawLine.trim();
    if (trimmed) pending = trimmed;
  }
  flush();
  return lines;
}

/** 提取一级与二级标题（1-A 大纲只展示这两级，避免 h3 刷屏）。 */
export function extractOutlineHeadings(markdown: string, limit = Number.POSITIVE_INFINITY): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (const line of scanOutlineLines(markdown)) {
    if (headings.length >= limit) break;
    if (line.kind !== "heading") continue;
    headings.push({ level: line.level, text: line.text });
  }
  return headings;
}

/**
 * 补上末尾未闭合的围栏，返回结尾闭合后的文本。
 *
 * 正文把最终回答的每个文本块单独渲染成 Markdown，围栏不会跨块；拼成一篇再解析时，
 * 前一块漏写的 ``` 会把下一块里正文能点到的标题当成代码，大纲编号就对不上了。
 */
function closeTrailingFence(markdown: string): string {
  if (!markdown) return markdown;
  const normalized = markdown.replace(/\r\n/g, "\n");
  let open: { char: string; length: number } | null = null;
  for (const line of normalized.split("\n")) {
    const match = line.match(FENCE);
    if (!match) continue;
    if (!open) open = { char: match[1][0], length: match[1].length };
    else if (closesFence(line, open)) open = null;
  }
  return open ? `${normalized}\n${open.char.repeat(open.length)}` : normalized;
}

/** 按正文的块边界拼接最终回答的文本块：先封住每块末尾的围栏，拼成一篇的解析结果才和逐块渲染一致。 */
export function joinAnswerBlocks(blocks: readonly string[]): string {
  return blocks.map(closeTrailingFence).join("\n\n");
}

/** 快速判断是否含一/二级标题：大纲行没有可展开的标题时不必渲染标题区。 */
export function hasOutlineHeadings(markdown: string): boolean {
  return scanOutlineLines(markdown).some((line) => line.kind === "heading");
}

/**
 * 带缓存的「这段回答有没有大纲标题」。
 *
 * 聊天滚动重测时会把每个已加载回答重新问一遍，内容没变就没必要重扫 Markdown。
 * 缓存以正文为键，上限只是兜底：调用方不会把每帧都变的流式正文交给它，满了丢最早一条。
 */
export function cachedHasOutlineHeadings(cache: Map<string, boolean>, markdown: string, limit = 200): boolean {
  const cached = cache.get(markdown);
  if (cached !== undefined) return cached;
  const result = hasOutlineHeadings(markdown);
  if (cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(markdown, result);
  return result;
}
