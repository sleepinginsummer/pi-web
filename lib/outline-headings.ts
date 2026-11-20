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
const FENCE = /^\s*(`{3,}|~{3,})/;

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
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
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
      const marker = fenceMatch[1];
      const char = marker[0];
      if (!inFence) {
        flush();
        inFence = { char, length: marker.length };
      } else if (inFence.char === char && marker.length >= inFence.length && /^\s*[`~]+\s*$/.test(rawLine)) {
        inFence = null;
      }
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
    if (line.kind !== "heading") continue;
    headings.push({ level: line.level, text: line.text });
    if (headings.length >= limit) break;
  }
  return headings;
}

/** 快速判断是否含一/二级标题：大纲行没有可展开的标题时不必渲染标题区。 */
export function hasOutlineHeadings(markdown: string): boolean {
  return scanOutlineLines(markdown).some((line) => line.kind === "heading");
}
