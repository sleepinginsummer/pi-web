import type { Content, Link, Parent, Root } from "mdast";
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkMath from "remark-math";
import type { Plugin } from "unified";
import type { Extension } from "micromark-util-types";

// Link schemes of desktop apps that open a note, a file or a meeting (#1108).
// A fixed list, not "any scheme but javascript:": the text comes from the model
// and from repository files, and OS handlers such as ms-msdt: or search-ms:
// have been exploited through a clicked link.
const appLinkSchemes = [
  "obsidian", "logseq", "notion",
  "vscode", "vscode-insiders", "cursor", "zed", "jetbrains",
  "zoommtg", "zoomus", "msteams", "slack",
];
const appLinkPattern = new RegExp(`^(?:${appLinkSchemes.join("|")}):`, "i");

// The anti-clobber prefix the sanitizer puts in front of every `id` in
// rendered content, so untrusted Markdown cannot shadow the page's own
// elements. The fragment-link fix below must use the identical value, so the
// schema that produces the prefixed ids pins the same constant.
const markdownClobberPrefix = defaultSchema.clobberPrefix ?? "user-content-";

const markdownSanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: markdownClobberPrefix,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    // 大纲跳转标记：只加在一/二级标题上（remarkAnswerHeadingMarkers 在 remark 阶段写，
    // 这里保留下来，原样 HTML 里的标题不会带上它）。
    h1: [...(defaultSchema.attributes?.h1 ?? []), "dataAnswerHeading"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "dataAnswerHeading"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", ...appLinkSchemes],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

/** react-markdown's URL filter, plus links to the apps above. */
export function markdownAppUrlTransform(value: string): string {
  return appLinkPattern.test(value) ? value : defaultUrlTransform(value);
}

/** Also keeps `file:` links, for renderers that open local files in the app. */
export function markdownUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : markdownAppUrlTransform(value);
}

/** A link that leaves the page: it names a scheme or another host. */
export function isExternalMarkdownHref(href: string | undefined): boolean {
  return Boolean(href && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href));
}

interface MarkdownFragmentClick {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: Pick<Element, "getAttribute" | "closest">;
  preventDefault(): void;
}

/**
 * A click on a `#fragment` link in rendered Markdown: brings the element it
 * names into view within the same rendered document (the closest
 * `.markdown-body`), as the Skills reader does with its headings. The browser's
 * own jump searches the whole page, where every chat message with a footnote
 * has its own `user-content-user-content-fn-1` and the file preview sits beside
 * the chat, so it could land in another message; it would also put the
 * fragment in the app's URL as a history entry. Modified clicks stay the
 * browser's.
 */
export function jumpToMarkdownFragment(event: MarkdownFragmentClick): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute("href");
  if (!href?.startsWith("#")) return;
  event.preventDefault();
  let id = href.slice(1);
  if (!id) return;
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape is matched as written.
  }
  const name = CSS.escape(id);
  event.currentTarget.closest(".markdown-body")
    ?.querySelector(`[id="${name}"], a[name="${name}"]`)
    ?.scrollIntoView({ block: "start" });
}

// 数学预处理在独立模块里（服务端与前端共用），这里继续按原路径导出。
export { normalizeDisplayMath } from "./display-math";

// Parse YAML frontmatter into a `yaml` node before the math/GFM plugins run, so
// the raw metadata never leaks into the rendered output (without it, the opening
// `---` becomes an <hr> and the closing `---` turns the YAML into a setext heading).
// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangled such ranges (#385).
const remarkGfmOptions = { singleTilde: false } as const;

// GFM autolink literals (`https://…`, `www.…`) stop only at whitespace, and the
// trailing-punctuation trim knows only ASCII punctuation, so a URL glued to CJK
// prose swallows that prose: `https://a.com，见这里` becomes one link whose href
// is `https://a.com，见这里`, and clicking it goes nowhere.
//
// This is upstream behaviour rather than a bug in remark-gfm: it follows GitHub,
// which also terminates autolinks only on ASCII punctuation (remarkjs/remark-gfm#83
// was closed as not planned for exactly that reason, pointing at
// github/cmark-gfm#377 — the open spec request to accept non-ASCII terminators).
// Until that lands, split the literal here. CJK punctuation is the sentence
// boundary in Chinese/Japanese, so the URL stays clickable and the prose stays
// prose. Ideographs are deliberately NOT boundaries, so a genuine CJK path such
// as `https://zh.wikipedia.org/wiki/中文条目` keeps working.
const cjkPunctuationPattern =
  /[\u3001\u3002\u3008-\u3011\u3014-\u301B\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7\uFF5E\u301C]/;

/**
 * Split every GFM autolink literal at its first CJK punctuation mark, turning the
 * trailing prose back into a plain text node.
 *
 * `source` must be the markdown the tree was parsed from. An autolink literal's
 * raw source **is** its text, while a hand-written `[text](url)` link's raw source
 * is `[text](url)` — comparing the two is what leaves explicit links untouched
 * even when their text happens to equal their url.
 */
export function splitAutolinkLiteralsAtCjkPunctuation(tree: Root, source: string): void {
  const walk = (node: Root | Parent): void => {
    const children = node.children as Content[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === "link") splitAutolinkLiteral(children, index, child, source);
      const current = children[index];
      if ("children" in current && Array.isArray(current.children)) walk(current as Parent);
    }
  };
  walk(tree);
}

function splitAutolinkLiteral(
  siblings: Content[],
  index: number,
  node: Link,
  source: string,
): void {
  if (node.title != null || node.children.length !== 1) return;
  const textNode = node.children[0];
  if (textNode.type !== "text") return;

  const start = node.position?.start;
  const end = node.position?.end;
  if (start?.offset == null || end?.offset == null) return;
  if (source.slice(start.offset, end.offset) !== textNode.value) return;

  const text = textNode.value;
  const cut = text.search(cjkPunctuationPattern);
  // `cut === 0` means the literal itself starts with punctuation — not a URL.
  if (cut <= 0 || !node.url.endsWith(text)) return;

  const head = text.slice(0, cut);
  const boundary = { line: start.line, column: start.column + cut, offset: start.offset + cut };
  // The url carries a `http://` (www.) or `mailto:` prefix the text does not.
  node.url = node.url.slice(0, node.url.length - text.length) + head;
  textNode.value = head;
  node.position = { start, end: boundary };
  siblings.splice(index + 1, 0, {
    type: "text",
    value: text.slice(cut),
    position: { start: boundary, end },
  });
}

function remarkSplitAutolinkLiterals() {
  return (tree: Root, file: { value?: unknown }): void => {
    splitAutolinkLiteralsAtCjkPunctuation(tree, typeof file.value === "string" ? file.value : "");
  };
}

// Reject ambiguous single-dollar pairs during tokenization, before math can
// swallow Markdown emphasis or links. A price's next dollar ("$20 ... $6")
// cannot close math, nor can the space before a later formula ("$20 and $x$").
// Keep the upstream tokenizer/resolver for real math, code, escapes and $$.
const remarkCurrencySafeMath: Plugin = function () {
  remarkMath.call(this);
  const data = this.data() as { micromarkExtensions?: Extension[] };
  const extension = data.micromarkExtensions?.at(-1);
  const constructs = extension?.text?.[36];
  for (const construct of Array.isArray(constructs) ? constructs : constructs ? [constructs] : []) {
    if (construct.name !== "mathText") continue;
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now();
      return tokenize.call(this, effects, (code) => {
        const source = this.sliceSerialize({ start, end: this.now() });
        if (source.startsWith("$") && !source.startsWith("$$")) {
          const content = source.slice(1, -1);
          const startsWithAmount = /^\s*[+-]?(?:\d|\.\d)/.test(content);
          const closesBeforeNumber = code !== null && code >= 48 && code <= 57;
          // Balanced padding ($ x + y $) remains supported, as does multiline
          // math. A one-sided space is prose, not an inline-math boundary.
          const mismatchedPadding = /^\s/.test(content) !== /\s$/.test(content);
          if (startsWithAmount && (closesBeforeNumber || mismatchedPadding)) return nok(code);
        }
        return ok(code);
      }, nok);
    };
  }
};

// Drive letters otherwise look like unknown URL schemes to the sanitizer.
// Rewrite only Markdown link destinations, before rehype and URL filtering.
function remarkWindowsFileLinks() {
  return (tree: Root): void => {
    const walk = (node: Root | Content): void => {
      if ((node.type === "link" || node.type === "definition") && /^\/?[A-Za-z]:\//.test(node.url)) {
        node.url = `file:///${node.url.replace(/^\//, "")}`;
      }
      if ("children" in node) node.children.forEach(walk);
    };
    walk(tree);
  };
}

interface OutlineMarkdownNode {
  type?: string;
  depth?: number;
  value?: string;
  children?: OutlineMarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * 原样 HTML 里的同名属性：只有本插件加的标记能参与跳转编号。
 *
 * 助手可以在正文里写 `<h2 data-answer-heading="1">`。清洗规则为了保住标记必须放行这个
 * 属性，于是原样 HTML 也能伪造一个；它会被正文算进序号，而大纲预览（只认 Markdown
 * 标题）不会列它，后面的标题就会往前错一位。所以先把这段属性从 HTML 原文里去掉：
 * 按标签和引号扫描，`title="a>b"` 这种带 `>` 的属性值不会让后面的标记漏掉。
 */
const RAW_ANSWER_HEADING_ATTRIBUTE = "data-answer-heading";

/**
 * 删掉一个标签里的指定属性。逐个属性扫描，属性值里的引号、`>` 都不会打断标签。
 * 属性名大小写不敏感；`</tag>`、声明和注释原样返回。
 */
function stripAttributeInTag(tag: string, name: string): string {
  if (!/^<[a-zA-Z]/.test(tag)) return tag;
  let result = "";
  let index = 0;
  while (index < tag.length && !/[\s/>]/.test(tag[index])) {
    result += tag[index];
    index += 1;
  }
  while (index < tag.length) {
    const start = index;
    while (index < tag.length && /\s/.test(tag[index])) index += 1;
    if (index >= tag.length) {
      result += tag.slice(start);
      break;
    }
    if (tag[index] === ">" || tag[index] === "/") {
      result += tag.slice(start);
      break;
    }
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    const attributeName = tag.slice(nameStart, index).toLowerCase();
    let after = index;
    while (after < tag.length && /\s/.test(tag[after])) after += 1;
    if (tag[after] === "=") {
      after += 1;
      while (after < tag.length && /\s/.test(tag[after])) after += 1;
      const quote = tag[after];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, after + 1);
        after = close === -1 ? tag.length : close + 1;
      } else {
        while (after < tag.length && !/[\s>]/.test(tag[after])) after += 1;
      }
    }
    if (attributeName !== name) result += tag.slice(start, after);
    index = after;
  }
  return result;
}

/** 从一段原样 HTML 里删掉指定的同名属性（大小写不敏感），标签以外的文字原样保留。 */
function stripAttributeFromHtml(html: string, name: string): string {
  let result = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      result += html.slice(index);
      break;
    }
    result += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) {
        result += html.slice(open);
        break;
      }
      result += html.slice(open, end + 3);
      index = end + 3;
      continue;
    }
    // 找到标签真正的结尾：引号里的 `>` 不算。
    let cursor = open + 1;
    let quote: string | null = null;
    while (cursor < html.length) {
      const character = html[cursor];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= html.length) {
      result += html.slice(open);
      break;
    }
    result += stripAttributeInTag(html.slice(open, cursor + 1), name);
    index = cursor + 1;
  }
  return result;
}

function stripRawAnswerHeadingAttributes(nodes: readonly OutlineMarkdownNode[]): void {
  for (const node of nodes) {
    if (node.type === "html" && typeof node.value === "string") {
      node.value = stripAttributeFromHtml(node.value, RAW_ANSWER_HEADING_ATTRIBUTE);
    }
    if (Array.isArray(node.children)) stripRawAnswerHeadingAttributes(node.children);
  }
}

/**
 * 给最终回答的顶层 h1/h2 打标记，供右侧大纲跳到正文时逐行对上。
 *
 * 大纲预览只列每段 Markdown 的顶层标题：引用块、列表、表格和原样 HTML 里的标题
 * 都不算，正文必须用同一套规则，否则两边编号会错位、跳到另一段。
 */
export function remarkAnswerHeadingMarkers() {
  return (tree: { children?: OutlineMarkdownNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    // 先抹掉原样 HTML 里的同名属性，只有下面这段给 Markdown 标题加的标记能留到正文。
    stripRawAnswerHeadingAttributes(tree.children);
    for (const node of tree.children) {
      if (node.type !== "heading" || typeof node.depth !== "number" || node.depth > 2) continue;
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, "data-answer-heading": "1" },
      };
    }
  };
}

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkCjkFriendly,
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkWindowsFileLinks,
];

// User messages keep every typed line break, as the TUI shows them (#680). The
// `.markdown-user-message p` pre-wrap rule only reaches paragraphs, so a soft
// break in a tight list item ("1. question\nA. option") or a heading collapsed
// into a space, and Chrome renders a lone `\r` as a space even under pre-wrap.
// Every line ending in text therefore becomes a <br>. It is a custom node that
// remark-rehype turns into a bare <br> through `data.hName`, not an mdast
// `break`: remark-rehype follows that <br> with a "\n" text node, which the
// pre-wrap rule renders as a second break, so hard breaks are swapped too. Code,
// inline code and math are other node types and keep their text.
interface MarkdownTreeNode {
  type: string;
  value?: string;
  children?: MarkdownTreeNode[];
  data?: { hName?: string };
  position?: { start: { line: number }; end: { line: number } };
}

const LINE_ENDING = /[ \t]*(?:\r\n|\r|\n)[ \t]*/;
// Containers whose children are blocks: an HTML block there becomes a paragraph.
const BLOCK_CONTAINER_TYPES = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

function lineBreakNode(): MarkdownTreeNode {
  return { type: "lineBreak", data: { hName: "br" } };
}

// pi's TUI prints a user message's HTML as the characters typed (pi-tui's
// Markdown, `case "html"`), so a pasted `<TableOperator v-model="x" />` or
// `<textarea>` reads as written instead of being parsed by rehype-raw and
// stripped by the sanitizer (#1407). Runs before the line breaks are kept, so
// a multi-line tag breaks like any text.
function htmlAsText(parent: MarkdownTreeNode): void {
  if (!parent.children) return;
  const blockParent = BLOCK_CONTAINER_TYPES.has(parent.type);
  parent.children = parent.children.map((node) => {
    if (node.type !== "html") {
      htmlAsText(node);
      return node;
    }
    const text = { type: "text", value: node.value ?? "" };
    return blockParent ? { type: "paragraph", children: [text] } : text;
  });
}

function keepLineBreaks(parent: MarkdownTreeNode): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap((node) => {
    if (node.type === "break") return [lineBreakNode()];
    if (node.type !== "text" || !node.value) {
      keepLineBreaks(node);
      return [node];
    }
    return node.value.split(LINE_ENDING).flatMap((line, index) => [
      ...(index > 0 ? [lineBreakNode()] : []),
      ...(line ? [{ type: "text", value: line }] : []),
    ]);
  });
}

function remarkUserText() {
  return (tree: MarkdownTreeNode) => {
    htmlAsText(tree);
    keepLineBreaks(tree);
  };
}

// A custom message may be laid out for a terminal (a status box, aligned bars),
// and pi's TUI keeps a paragraph's line indents. The parser drops them from the
// text, so they come back from the source. Only a top-level paragraph: inside a
// list or a quote the source line's whitespace is part of the container's.
function restoreLineIndents(paragraph: MarkdownTreeNode, sourceLines: string[]): void {
  if (!paragraph.position) return;
  let lineIndex = paragraph.position.start.line - 1;
  const indentNode = (): MarkdownTreeNode[] => {
    const indent = /^[ \t]*/.exec(sourceLines[lineIndex] ?? "")?.[0];
    return indent ? [{ type: "text", value: indent }] : [];
  };
  const firstLineIndent = indentNode();
  const walk = (parent: MarkdownTreeNode) => {
    parent.children = parent.children?.flatMap((node) => {
      if (node.type === "lineBreak") {
        lineIndex += 1;
        return [node, ...indentNode()];
      }
      if (node.children) walk(node);
      // A code span or image may cross lines without a line break node.
      else if (node.position) lineIndex += node.position.end.line - node.position.start.line;
      return [node];
    });
  };
  walk(paragraph);
  paragraph.children = [...firstLineIndent, ...(paragraph.children ?? [])];
}

function remarkTextLayout() {
  return (tree: MarkdownTreeNode, file: { value: unknown }) => {
    htmlAsText(tree);
    keepLineBreaks(tree);
    const sourceLines = String(file.value).split(/\r\n|\r|\n/);
    for (const node of tree.children ?? []) {
      if (node.type === "paragraph") restoreLineIndents(node, sourceLines);
    }
  };
}

export const markdownUserRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  ...(markdownRemarkPlugins ?? []),
  remarkUserText,
];
export const markdownTextLayoutRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  ...(markdownRemarkPlugins ?? []),
  remarkTextLayout,
];
export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkCjkFriendly,
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkWindowsFileLinks,
];

interface SanitizedNode {
  type?: string;
  properties?: Record<string, unknown>;
  children?: SanitizedNode[];
}

/**
 * GitHub rewrites both sides of a content anchor. cmark-gfm prefixes rendered
 * `id`s with `user-content-` (anti-clobber) and rewrites same-document fragment
 * links to match, so a hand-written pair like `<a id="toc"></a>` with
 * `[ToC](#toc)` still lands after rendering. `rehype-sanitize` copies only the
 * `id` half of that — `defaultSchema`'s `clobber` + `clobberPrefix` — which on
 * its own breaks every in-document anchor pair: the element gains the prefix
 * and the link pointing at it does not.
 *
 * This plugin runs after sanitizing and prefixes fragment links exactly as
 * unconditionally as sanitizing prefixes ids, so an id and an href that matched
 * before sanitizing still match afterwards. Footnote references need it for the
 * same reason: `mdast-util-to-hast` generates both their sides already prefixed
 * and sanitizing prefixes the id once more, so an unprefixed href would strand
 * the footnote link behind the doubled prefix.
 *
 * Links to page elements keep being unreachable from Markdown — that is the
 * clobber protection doing its job, not this plugin. A bare `#` has no fragment
 * to pair and stays as written.
 */
function rehypeMatchClobberedIds(): (tree: unknown) => void {
  return (tree: unknown): void => {
    const visit = (node: SanitizedNode): void => {
      if (!node || typeof node !== "object") return;
      const href = node.properties?.href;
      if (node.type === "element" && typeof href === "string" && href.startsWith("#") && href.length > 1) {
        node.properties!.href = `#${markdownClobberPrefix}${href.slice(1)}`;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree as SanitizedNode);
  };
}

function hastText(node: HastContent): string {
  return node.type === "text" ? node.value : node.type === "element" ? node.children.map(hastText).join("") : "";
}

/**
 * Display math (`$$…$$`, a ```math fence: `<pre><code class="language-math">`)
 * goes into a `<div data-math-source>` holding its LaTeX, which MarkdownBody
 * gives a Copy button (#1380). KaTeX then renders the formula inside the div;
 * its glyphs are no source to copy. Runs after sanitizing, so the attribute is
 * never one a user's own HTML could carry (the schema drops `data-*`), and
 * inline math (no `<pre>`) stays as it is.
 */
function rehypeDisplayMathSource() {
  return (tree: HastRoot): void => {
    const visit = (parent: HastRoot | HastElement): void => {
      parent.children = parent.children.map((child) => {
        if (child.type !== "element") return child;
        const code = child.tagName === "pre" && child.children.length === 1 ? child.children[0] : null;
        const classes = code?.type === "element" && code.tagName === "code" ? code.properties.className : null;
        if (Array.isArray(classes) && classes.includes("language-math")) {
          return {
            type: "element",
            tagName: "div",
            properties: { className: ["markdown-math-display"], dataMathSource: hastText(child).replace(/\n$/, "") },
            children: [child],
          };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeMatchClobberedIds,
  rehypeDisplayMathSource,
  [rehypeKatex, { throwOnError: false, strict: false }],
];

/** GitHub's heading slugs for `#fragment` links, as a data attribute: two rendered documents never share an id. */
function markdownHeadingAnchors() {
  return (tree: HastRoot) => {
    const seen = new Map<string, number>();
    const visit = (node: HastRoot | HastElement) => node.children.forEach((child) => {
      if (child.type !== "element") return;
      if (/^h[1-6]$/.test(child.tagName)) {
        const base = hastText(child).toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
        // As github-slugger numbers repeats: "a", "a", "a-1" become a, a-1, a-1-1.
        let slug = base;
        while (seen.has(slug)) {
          seen.set(base, seen.get(base)! + 1);
          slug = `${base}-${seen.get(base)}`;
        }
        seen.set(slug, 0);
        child.properties.dataHeadingAnchor = slug;
      }
      visit(child);
    });
    visit(tree);
  };
}

// A document whose `#fragment` links lead to its headings (Settings › Skills).
// Anchors come before KaTeX, which writes each formula's text twice.
export const markdownDocumentRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  markdownHeadingAnchors,
  rehypeDisplayMathSource,
  [rehypeKatex, { throwOnError: false, strict: false }],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeMatchClobberedIds,
  [rehypeKatex, { throwOnError: false, strict: false }],
];
