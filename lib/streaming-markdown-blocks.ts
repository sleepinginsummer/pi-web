/**
 * 流式 markdown 分块器。
 *
 * 流式输出期间累积文本每一帧都会变化，如果每帧都重新解析整篇文本，单帧成本随回答
 * 长度线性增长（10KB 正文约 30ms），主线程被占满，输入框按键要排队几十毫秒。
 * 这里把累积文本切成「已经稳定、可以整块缓存」的前缀块和「仍在增长」的尾部，
 * 调用方只需要重新解析尾部。
 *
 * 切点只取顶层空行处，并避开解析结果会依赖后续文本或跨行结构的位置：
 * 未闭合的代码围栏、原样 HTML 块、HTML 注释、`$$` 数学块、列表与引用的续行、
 * 引用式链接和脚注定义。因此块内解析结果与整篇解析一致；流式期间只允许极少数
 * 结构（还没流到定义的引用式链接、脚注）短暂不一致，`message_end` 的整篇渲染
 * 是最终结果。
 */

export interface StreamingMarkdownFence {
  /** 围栏行上的 info string，例如 `ts`、`mermaid`；没有语言时为空字符串。 */
  info: string;
  /** 围栏行之后已经收到的内容，保留原始换行。 */
  code: string;
  /** 围栏行开头到文末的原始切片，用于校验切分不丢字符。 */
  raw: string;
}

export interface StreamingMarkdownSplit {
  /** 已经稳定、可以整体缓存的完整块，按顺序拼接等于 `source` 的已冻结前缀。 */
  blocks: string[];
  /** 仍在增长、每帧需要重新解析的 markdown 尾部。 */
  tail: string;
  /** 尾部里尚未闭合的代码围栏；有值时 `tail` 只包含围栏之前的部分。 */
  openFence: StreamingMarkdownFence | null;
}

/** 原样文本 HTML 块：内部按原文保留，不能在其中切分。 */
const RAW_TEXT_TAG_PATTERN = /^ {0,3}<(script|pre|style|textarea|title|xmp|noembed|noframes|noscript|plaintext)\b/i;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE_PATTERN = /^[ \t]*$/;
/** 归一化后的展示数学块独占一行，和代码围栏一样需要成对出现。 */
const MATH_FENCE_PATTERN = /^ {0,3}\$\$[ \t]*$/;
const LINK_DEFINITION_PATTERN = /^ {0,3}\[[^\]]+\]:/;
const FOOTNOTE_DEFINITION_PATTERN = /^ {0,3}\[\^[^\]]*\]:/;
/** 列表项、引用行：它们的前后空行属于容器内部，不能作为切点。 */
const CONTAINER_MARKER_PATTERN = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}>/;

/**
 * 跨行结构状态。空行是否能作为切点、当前行属于哪个结构都由它决定；
 * 同一时刻最多只有一个结构打开，所以用互斥联合而不是并列的布尔量。
 */
type BlockStructure =
  | { kind: "fence"; marker: string; size: number; openOffset: number; contentOffset: number; info: string }
  | { kind: "rawText"; tag: string }
  | { kind: "comment" }
  | { kind: "math" }
  | null;

interface StreamScanResult {
  /** 已确认安全的切点偏移，递增排列。 */
  cuts: number[];
  /** 扫描结束时的结构状态；围栏未闭合时调用方可以走纯文本快路径。 */
  structure: BlockStructure;
}

function isFenceClosing(line: string, fence: { marker: string; size: number }): boolean {
  const match = FENCE_OPEN_PATTERN.exec(line);
  if (!match) return false;
  const marker = match[1];
  if (marker[0] !== fence.marker || marker.length < fence.size) return false;
  return match[2].trim() === "";
}

/**
 * 判断空行两侧的两个非空行能否作为切点。保守优先：拿不准就返回 false，
 * 切分不足只会保留一点成本，切错会让渲染结果与整篇解析不一致。
 */
function isSafeCut(previous: string | null, next: string): boolean {
  if (previous === null) return false;
  // 前一行缩进说明它可能是列表项、引用或缩进代码的续行。
  if (/^[ \t]/.test(previous)) return false;
  if (CONTAINER_MARKER_PATTERN.test(previous)) return false;
  // 后一行缩进说明它可能继续前面打开的容器。
  if (/^[ \t]/.test(next)) return false;
  if (CONTAINER_MARKER_PATTERN.test(next)) return false;
  if (LINK_DEFINITION_PATTERN.test(next) || FOOTNOTE_DEFINITION_PATTERN.test(next)) return false;
  return true;
}

/** 在顶层行上尝试开启一个新结构；没有匹配时返回 null。 */
function openStructure(line: string, lineStart: number, nextLineStart: number): BlockStructure {
  const fenceOpen = FENCE_OPEN_PATTERN.exec(line);
  if (fenceOpen) {
    return {
      kind: "fence",
      marker: fenceOpen[1][0],
      size: fenceOpen[1].length,
      openOffset: lineStart,
      contentOffset: nextLineStart,
      info: fenceOpen[2].trim(),
    };
  }

  const rawTextOpen = RAW_TEXT_TAG_PATTERN.exec(line);
  if (rawTextOpen) {
    const tag = rawTextOpen[1].toLowerCase();
    const remainder = line.slice(rawTextOpen.index + rawTextOpen[0].length);
    // 同一行内已经闭合的标签不进入原样块。
    if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) return { kind: "rawText", tag };
    return null;
  }

  if (line.includes("<!--") && !line.includes("-->")) return { kind: "comment" };
  if (MATH_FENCE_PATTERN.test(line)) return { kind: "math" };
  return null;
}

/** 行级别的结构推进：结构内部只判断是否退出，顶层行则尝试开启新结构。 */
function advanceStructure(
  structure: BlockStructure,
  line: string,
  lineStart: number,
  nextLineStart: number,
): BlockStructure {
  if (structure) {
    switch (structure.kind) {
      case "rawText":
        return new RegExp(`</${structure.tag}\\s*>`, "i").test(line) ? null : structure;
      case "comment":
        return line.includes("-->") ? null : structure;
      case "fence":
        return isFenceClosing(line, structure) ? null : structure;
      case "math":
        return MATH_FENCE_PATTERN.test(line) ? null : structure;
    }
  }
  return openStructure(line, lineStart, nextLineStart);
}

function scanStreamingMarkdown(source: string): StreamScanResult {
  const lines = source.split("\n");
  const cuts: number[] = [];
  let structure: BlockStructure = null;
  let lastNonBlank: string | null = null;
  /** 当前挂起的顶层空行段结束偏移；-1 表示没有候选切点。 */
  let blankRunEnd = -1;
  let offset = 0;

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineStart = offset;
    const lineEnd = offset + rawLine.length;
    const nextLineStart = Math.min(source.length, lineEnd + 1);
    offset = lineEnd + 1;

    if (BLANK_LINE_PATTERN.test(line)) {
      // 结构内部的空行不构成切点，也不能沿用结构之前挂起的候选。
      blankRunEnd = structure ? -1 : nextLineStart;
      continue;
    }

    // 非空行：先用进入本行之前的状态判定挂起的空行段，再推进结构状态，
    // 这样「空行 + 围栏开启行」这种边界仍然可以切分。
    if (blankRunEnd >= 0) {
      if (!structure && isSafeCut(lastNonBlank, line)) cuts.push(blankRunEnd);
      blankRunEnd = -1;
    }

    structure = advanceStructure(structure, line, lineStart, nextLineStart);
    lastNonBlank = line;
  }

  return { cuts, structure };
}

function assembleSplit(source: string, scan: StreamScanResult): StreamingMarkdownSplit {
  const blocks: string[] = [];
  let blockStart = 0;
  for (const cut of scan.cuts) {
    if (cut <= blockStart) continue;
    blocks.push(source.slice(blockStart, cut));
    blockStart = cut;
  }

  // 未闭合围栏交给调用方按纯文本渲染：围栏内容每帧都在变，重新解析整段代码
  // 既慢又没必要（闭合后它会成为稳定的普通块）。
  const { structure } = scan;
  if (structure?.kind === "fence" && structure.openOffset >= blockStart) {
    return {
      blocks,
      tail: source.slice(blockStart, structure.openOffset),
      openFence: {
        info: structure.info,
        code: source.slice(structure.contentOffset),
        raw: source.slice(structure.openOffset),
      },
    };
  }

  return { blocks, tail: source.slice(blockStart), openFence: null };
}

/**
 * 把累积 markdown 切成可缓存前缀块和增长尾部。函数是纯函数：同样的输入永远
 * 得到同样的切点，因此对同一篇文档的连续快照，先前返回的块文本逐字不变。
 */
export function splitStreamingMarkdown(source: string): StreamingMarkdownSplit {
  if (!source) return { blocks: [], tail: "", openFence: null };
  return assembleSplit(source, scanStreamingMarkdown(source));
}
