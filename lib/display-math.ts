/**
 * 展示数学（`\[...\]`、`$$…$$`）的预处理：把正文里的行内/块级公式整理成 remark-math
 * 能稳定解析的形状，并改写转义反引号。
 *
 * 独立成模块的原因：正文、大纲预览、完整目录、文件预览都要跑同一份预处理，否则
 * 「正文里是公式、目录里是标题」这类不一致就会出现（服务端目录不能为了它去 import
 * 客户端渲染模块 `lib/markdown.ts`）。
 */

/**
 * `value.replace(pattern, replace)` as if `pattern` began with the lookbehind
 * `(?<![notAfter])`: a match starts with `opener` and must not follow any
 * character of `notAfter`. Safari only parses lookbehind from 16.4, and one
 * regex literal it cannot parse fails the whole script chunk, which left iOS
 * 16.2 on a blank page (#753). The sticky `pattern` is tried at each `opener`
 * in turn, the order in which the lookbehind version tries start positions.
 */
function replaceNotPrecededBy(
  value: string,
  opener: string,
  notAfter: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
): string {
  let result = "";
  let copied = 0;
  for (let index = value.indexOf(opener); index !== -1; index = value.indexOf(opener, index + 1)) {
    if (index > 0 && notAfter.includes(value[index - 1])) continue;
    pattern.lastIndex = index;
    const match = pattern.exec(value);
    if (!match) continue;
    result += value.slice(copied, index) + replace(match);
    copied = pattern.lastIndex;
    index = copied - 1;
  }
  return result + value.slice(copied);
}

// The closing backtick must not follow `\` or another backtick, so the content
// ends with a character that is neither.
const escapedInlineCodePattern = /`((?:[^`\n]|\\`)*?[^\\`\n])`(?!`)/y;

function rewriteEscapedInlineCodeBackticks(line: string): string {
  return replaceNotPrecededBy(line, "`", "\\`", escapedInlineCodePattern, ([match, content]) => {
    const code = content.replace(/\\`/g, "`");
    if (code === content) return match;
    const marker = "`".repeat(Math.max(...(code.match(/`+/g)?.map((run) => run.length) ?? [0])) + 1);
    return `${marker}${code}${marker}`;
  });
}

export function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineCodeMarkerSize = 0;
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size && /^[ \t]*$/.test(line.slice(fenceMatch[0].length))) fence = null;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (fence) {
      normalized.push(line);
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) || line.trim() === "") {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (!inlineCodeMarkerSize) line = rewriteEscapedInlineCodeBackticks(line);

    if (inlineCodeMarkerSize || line.includes("`")) {
      inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize);
      normalized.push(line);
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a "lazy continuation" line, which makes remark-math
        // mis-parse the fence pair: the opening `$$` turns into an empty math node
        // and the closing one swallows the rest of the document as math content.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const looseBracketDisplayOneLine = line.match(/^([ ]{0,3})\[[ \t]*(.+?)[ \t]*\][ \t]*$/);
    if (looseBracketDisplayOneLine) {
      const math = looseBracketDisplayOneLine[2].trim();
      if (isLikelyMathExpression(math)) {
        normalized.push(
          `${looseBracketDisplayOneLine[1]}$$`,
          `${looseBracketDisplayOneLine[1]}${math}`,
          `${looseBracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1);
      if (closingIndex !== -1) {
        // Same lazy-continuation guard as above: indent content lines that sit at
        // column 0 so the block stays parseable when nested inside a list item.
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        // See the comment on bracketDisplayOneLine: without matching indentation,
        // a formula nested in a GFM list item is mis-parsed by remark-math and the
        // text after the formula renders as a garbled KaTeX error block.
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // remark-math requires both `$$` delimiters to sit on their own lines, but
    // models also emit display math as a multi-line block where the opening `$$`
    // is glued to the first formula line and/or the closing `$$` is glued to the
    // end of the last one (`$$x = 1` + `y = 2$$`). Without normalization such a
    // block swallows the following text as math content and renders as garbage.
    const displayMathMultiLine = line.match(/^([ \t]{0,3})\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Only treat this as a block opener if no other `$$` is embedded mid-line
      // (e.g. `$$x$$ and text` stays untouched and is rendered as inline math).
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(
          lines,
          index + 1,
          indent,
          unmatchedDisplayMathUntil,
        );
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
      }
    }

    // Bare `$$` opener (possibly indented inside a GFM list item). Two problems
    // need fixing: (1) when the closing `$$` is glued to the last content line
    // (e.g. `z = w$$`) remark-math never finds a valid closing fence and swallows
    // the rest of the document; (2) inside a list item, content lines at column 0
    // are lazy continuations that break the math flow. Both are fixed by moving
    // the closing `$$` to its own line and re-indenting lazy content lines.
    // A column-0 block with a properly detached closing `$$` is left untouched
    // (remark-math already parses it correctly).
    const displayMathBareOpen = line.match(/^([ \t]{0,3})\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(
        lines,
        index + 1,
        indent,
        unmatchedDisplayMathUntil,
      );
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };

    // A new Markdown block cannot belong to the preceding formula. In particular,
    // do not let a later sibling list item provide a closing `$$` for this block.
    if (isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
      unmatchedUntil.set(indent, index);
      return null;
    }

    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  // Multiple unmatched glued openers with the same indentation previously each
  // scanned to EOF. Cache this range so the overall search remains linear.
  unmatchedUntil.set(indent, lines.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  return line.startsWith(indent) && /^\$\$\s*$/.test(line.slice(indent.length));
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  if (!line.startsWith(indent)) return null;

  const match = line.slice(indent.length).match(/^(.+?)\$\$\s*$/);
  if (!match) return null;

  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^ {0,3}\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  );
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;

  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function updateInlineCodeMarker(line: string, initialMarkerSize: number): number {
  let markerSize = initialMarkerSize;
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (line[end] === "`") end++;
    const runSize = end - cursor;
    if (markerSize === 0) markerSize = runSize;
    else if (runSize === markerSize) markerSize = 0;
    cursor = end;
  }
  return markerSize;
}

// `\(` … `\)` whose closing backslash is not itself escaped.
const inlineLatexMathPattern = /\\\(([^`\r\n$]*?[^`\r\n$\\])\\\)/y;

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  return replaceNotPrecededBy(line, "\\(", "\\", inlineLatexMathPattern, ([match, math]) =>
    math.trim() ? `$${math}$` : match,
  );
}

function isLikelyMathExpression(value: string): boolean {
  return /\\[A-Za-z]+/.test(value) && !/\b(?:https?|file|mailto):|\b[A-Za-z]:\\|^\\\\/i.test(value);
}
