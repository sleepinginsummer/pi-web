import type { Node, Parent } from "mdast";
import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { normalizeDisplayMath } from "./display-math";
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

/** 列表项标记：缩进 + 标记 + 分隔空白，用来算出列表项内容的缩进。 */
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)/;

/**
 * 分隔线：三个以上同一种 `-` / `*` / `_`，字符之间允许空格。
 *
 * CommonMark 里分隔线优先于列表项——`- - -` 是分隔线，不是「内容为 `- -` 的列表项」。
 * 当成列表项会让它下面的 `  ## 标题` 变成列表内部的嵌套标题：正文照样渲染成标题，
 * 大纲却因为「列表里不算顶层标题」而丢掉它，展开入口也不出现。
 */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * 逐行扫描 Markdown，按出现顺序返回标题行与正文行（代码块整体跳过）。
 *
 * 只认**顶层**标题：正文给最终回答的每个文本块单独渲染 Markdown，remark 只会给
 * 顶层 h1/h2 打 `data-answer-heading` 标记，列表项里的 `  ## 标题` 在正文里是
 * 嵌套标题，点不到。这里按 CommonMark 的列表缩进规则判一下，让大纲与服务端摘要
 * 跟正文认同一批标题。
 */
export function scanOutlineLines(markdown: string): OutlineLine[] {
  if (!markdown) return [];
  const lines: OutlineLine[] = [];
  /**
   * 打开着的围栏：`containerIndent` 是它所在列表项的内容缩进（不在列表里是 0）。
   *
   * 列表项里的围栏**不靠结束标记也能结束**：缩进退回容器之外时它跟着收尾，
   * 和 remark 渲染正文的行为一致。否则一个漏写结束标记的围栏会把后面的
   * `## 标题` 当成代码，正文显示了标题、大纲却没有。
   */
  let inFence: { char: string; length: number; containerIndent: number } | null = null;
  // 上一行正文：下一行若是 Setext 下划线，它其实是标题文字。`topLevel` 记住它是否在列表外。
  let pending: { text: string; topLevel: boolean } | null = null;
  // 每层打开着的列表项的内容缩进；空行不关闭列表，只有缩进回到外面才关闭。
  const listContentIndents: number[] = [];

  const flush = () => {
    if (pending !== null) lines.push({ kind: "text", text: pending.text });
    pending = null;
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const indent = rawLine.length - rawLine.trimStart().length;
    // 缩进退回围栏容器之外（列表项结束）：未闭合的围栏在这里收尾，这一行继续按正文处理。
    if (inFence && rawLine.trim() && indent < inFence.containerIndent) inFence = null;
    const fenceMatch = rawLine.match(FENCE);
    if (fenceMatch) {
      if (!inFence) {
        flush();
        // 先按缩进关掉更深的列表：顶格的围栏在 remark 里不属于上一项。
        while (listContentIndents.length > 0 && indent < listContentIndents[listContentIndents.length - 1]) {
          listContentIndents.pop();
        }
        inFence = {
          char: fenceMatch[1][0],
          length: fenceMatch[1].length,
          containerIndent: listContentIndents[listContentIndents.length - 1] ?? 0,
        };
      } else if (closesFence(rawLine, inFence)) {
        inFence = null;
      }
      // 围栏里混入另一种围栏字符的行是代码内容：既不是关闭行，也不参与正文扫描。
      continue;
    }
    if (inFence) continue;

    const thematicBreak = THEMATIC_BREAK.test(rawLine);
    const marker = thematicBreak ? null : rawLine.match(LIST_MARKER);
    let insideList = false;
    if (marker) {
      const markerIndent = marker[1].length;
      const contentIndent = markerIndent + marker[2].length + marker[3].length;
      while (listContentIndents.length > 0 && markerIndent < listContentIndents[listContentIndents.length - 1]) {
        listContentIndents.pop();
      }
      listContentIndents.push(contentIndent);
      insideList = true;
    } else if (rawLine.trim()) {
      // 缩进回到当前列表项内容之外，这一项（以及更外层的列表）就结束了。
      while (listContentIndents.length > 0 && indent < listContentIndents[listContentIndents.length - 1]) {
        listContentIndents.pop();
      }
      insideList = listContentIndents.length > 0;
    }

    const setext = rawLine.match(SETEXT_UNDERLINE);
    if (setext && pending !== null) {
      if (pending.topLevel && isSetextTextLine(pending.text)) {
        const text = stripInlineMarkdown(pending.text);
        if (text) lines.push({ kind: "heading", level: setext[1][0] === "=" ? 1 : 2, text });
      } else {
        lines.push({ kind: "text", text: pending.text });
      }
      pending = null;
      continue;
    }

    const atx = rawLine.match(ATX_HEADING);
    if (atx) {
      flush();
      // 列表项里的标题在正文里是嵌套节点，没有标记，不算大纲标题。
      if (insideList) continue;
      const text = stripInlineMarkdown(atx[2]);
      if (text) lines.push({ kind: "heading", level: atx[1].length === 1 ? 1 : 2, text });
      continue;
    }

    flush();
    // 分隔线不是正文：上面已经按缩进关掉了更深的列表，这里不要再把它当成待定段落。
    if (thematicBreak) continue;
    const trimmed = rawLine.trim();
    if (trimmed) pending = { text: trimmed, topLevel: !insideList };
  }
  flush();
  return lines;
}


/**
 * 大纲用的 Markdown 解析器：与正文（`lib/markdown.ts` 的 `markdownRemarkPlugins`）同一条规则。
 *
 * 手写的行扫描器只能逼近 CommonMark，凡是「这一行算不算正文」的判断都能出错：列表里
 * 未闭合的围栏、反引号围栏的 info string 含反引号（那其实不是围栏）、HTML 块里的 `#`
 * （不是标题）、`$$` 数学块、frontmatter……每漏一条就会出现「正文显示了标题、大纲里却没有」
 * 或反过来。这里只带上会改变块结构的插件，其余行内插件（cjk-friendly、自动链接、
 * 货币安全数学、Windows 路径）不影响标题结构：
 * - remarkFrontmatter：`---` 包住的 frontmatter 不是正文，里面的 `#` 不是标题；
 * - remarkMath：`$$` 块整块是数学，里面的 `#` 不是标题；
 * - remarkGfm：与正文一致（表格等扩展本身不产生标题）。
 * 加新插件前先确认它会不会改变块结构，改了就要同步到这里（`session-outline.test.mjs`
 * 有按正文插件表复算的对照用例）。
 */
const headingProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath);

type TextLikeNode = Node & { value?: unknown; alt?: unknown; children?: readonly TextLikeNode[] };

/** 标题文字：文本、行内代码、行内数学取 value，链接/强调等取子树，图片取 alt。 */
function headingText(node: TextLikeNode): string {
  if (node.type === "image" || node.type === "imageReference") {
    return typeof node.alt === "string" ? node.alt : "";
  }
  if (typeof node.value === "string") return node.value;
  const children = (node as Parent).children as readonly TextLikeNode[] | undefined;
  return Array.isArray(children) ? children.map(headingText).join("") : "";
}

/**
 * 提取一级与二级标题（1-A 大纲只展示这两级，避免 h3 刷屏）。
 *
 * 只认根节点的 h1/h2：引用块、列表、表格和原样 HTML 里的标题在正文里没有跳转标记。
 */
export function extractOutlineHeadings(markdown: string, limit = Number.POSITIVE_INFINITY): OutlineHeading[] {
  if (!markdown || limit <= 0) return [];
  const headings: OutlineHeading[] = [];
  // 正文、展开预览和文件预览都先跑 `normalizeDisplayMath` 再渲染，目录必须吃同一份输入：
  // 否则 `\[ … \]` 里的 `## 小标题` 在正文里是公式内容，在目录里就成了标题。
  for (const node of headingProcessor.parse(normalizeDisplayMath(markdown)).children) {
    if (headings.length >= limit) break;
    if (node.type !== "heading" || node.depth > 2) continue;
    const text = headingText(node).replace(/\s+/g, " ").trim();
    if (text) headings.push({ level: node.depth === 1 ? 1 : 2, text });
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

/**
 * 逐块解析顶层标题（可截断）。
 *
 * 正文把最终回答的每个文本块单独渲染成 Markdown，拼接后的顶层结构可能不同：
 * 第二块以两格缩进的标题开头时，拼进前一块的列表里就成了嵌套。服务端目录、
 * 前端展开判断都用这一份逐块结果，未加载轮次和已加载轮次才认同一批标题。
 */
export function outlineHeadingsFromBlocks(
  blocks: readonly string[],
  limit = Number.POSITIVE_INFINITY,
): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (const block of blocks) {
    if (headings.length >= limit) break;
    headings.push(...extractOutlineHeadings(block, limit - headings.length));
  }
  return headings;
}

/**
 * 粗筛：整篇里连一个 ATX 记号（`#`/`##`）或 Setext 下划线都没有时，任何解析器都不会
 * 给出标题。它只做字符判断，宁多勿少——命中的仍交给 remark 定夺。
 */
const MAYBE_ATX_HEADING = /^ {0,3}#{1,2}(?:[ \t]|$)/m;
const MAYBE_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/m;

/** 快速判断是否含一/二级标题：没有可展开的标题时不必渲染标题区。 */
export function hasOutlineHeadings(markdown: string): boolean {
  if (!markdown) return false;
  if (!MAYBE_ATX_HEADING.test(markdown) && !MAYBE_SETEXT.test(markdown)) return false;
  return extractOutlineHeadings(markdown, 1).length > 0;
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
