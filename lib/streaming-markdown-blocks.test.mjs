import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { splitStreamingMarkdown } = await jiti.import("./streaming-markdown-blocks.ts");

/** 拼接不变式：块 + 尾部 + 未闭合围栏原始切片必须等于输入本身。 */
function assertRebuilds(split, source) {
  assert.equal(split.blocks.join("") + split.tail + (split.openFence?.raw ?? ""), source);
}

/** 扫描一段文本的结构状态，用于断言冻结块自身是自洽的。 */
function scanStructure(text) {
  const state = { fence: null, math: false, rawTag: null, comment: false };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (state.rawTag) {
      if (new RegExp(`</${state.rawTag}\\s*>`, "i").test(line)) state.rawTag = null;
      continue;
    }
    if (state.comment) {
      if (line.includes("-->")) state.comment = false;
      continue;
    }
    if (state.fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === state.fence.marker && close[1].length >= state.fence.size) state.fence = null;
      continue;
    }
    if (state.math) {
      if (/^ {0,3}\$\$[ \t]*$/.test(line)) state.math = false;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const rawOpen = /^ {0,3}<(script|pre|style|textarea|title|xmp|noembed|noframes|noscript|plaintext)\b/i.exec(line);
    if (open) state.fence = { marker: open[1][0], size: open[1].length };
    else if (rawOpen) {
      const tag = rawOpen[1].toLowerCase();
      const remainder = line.slice(rawOpen.index + rawOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) state.rawTag = tag;
    } else if (line.includes("<!--") && !line.includes("-->")) state.comment = true;
    else if (/^ {0,3}\$\$[ \t]*$/.test(line)) state.math = true;
  }
  return state;
}

/** 每个冻结块都必须是自洽的：不能停在未闭合的围栏、数学块、原样 HTML 块或注释里。 */
function assertBlocksSelfContained(split) {
  for (const block of split.blocks) {
    const state = scanStructure(block);
    assert.deepEqual(
      state,
      { fence: null, math: false, rawTag: null, comment: false },
      `冻结块停在未闭合结构里：${JSON.stringify(block.slice(0, 60))}`,
    );
  }
}

const document = [
  "# 标题",
  "",
  "第一段说明文字，包含 `inline code` 与 **粗体**。",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| a | b |",
  "",
  "第二段文字。",
  "",
  "```mermaid",
  "graph TD;",
  "```",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "结尾段落。",
  "",
].join("\n");

test("切分结果可以无损拼回原文", () => {
  for (let end = 1; end <= document.length; end++) {
    const source = document.slice(0, end);
    assertRebuilds(splitStreamingMarkdown(source), source);
  }
});

test("连续快照里已经冻结的块逐字不变", () => {
  let previousBlocks = [];
  for (let end = 1; end <= document.length; end++) {
    const split = splitStreamingMarkdown(document.slice(0, end));
    assert.ok(
      split.blocks.length >= previousBlocks.length,
      `块数量回退：${previousBlocks.length} -> ${split.blocks.length}`,
    );
    for (let index = 0; index < previousBlocks.length; index++) {
      assert.equal(split.blocks[index], previousBlocks[index], `第 ${index} 块在快照增长后发生了变化`);
    }
    previousBlocks = split.blocks;
  }
});

test("顶层块会被冻结，长回答只留下小尾部", () => {
  const split = splitStreamingMarkdown(document.slice(0, document.length - 1));
  assert.ok(split.blocks.length >= 5, `块数量过少：${split.blocks.length}`);
  assert.ok(split.tail.length < 200, `尾部仍然过长：${split.tail.length}`);
  assertBlocksSelfContained(split);
});

test("不在未闭合围栏内部切分，并把围栏交给调用方", () => {
  const source = "说明文字。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
  const split = splitStreamingMarkdown(source);
  assert.deepEqual(split.blocks, ["说明文字。\n\n"]);
  assert.equal(split.tail, "");
  assert.equal(split.openFence?.info, "ts");
  assert.equal(split.openFence?.code, "const a = 1;\n\nconst b = 2;\n");
  assertRebuilds(split, source);
  assertBlocksSelfContained(split);
});

test("围栏闭合后整块冻结", () => {
  const source = "说明文字。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后续段落";
  const split = splitStreamingMarkdown(source);
  assert.equal(split.openFence, null);
  assert.ok(split.blocks.some((block) => block.includes("const a = 1;")));
  assert.equal(split.tail, "后续段落");
  assertBlocksSelfContained(split);
});

test("展示数学块整体冻结，不会被切开", () => {
  const source = "前文。\n\n$$\nx = 1\n\ny = 2\n$$\n\n后文";
  const split = splitStreamingMarkdown(source);
  assert.ok(split.blocks.join("").includes("$$\nx = 1"), "数学块没有冻结");
  assertBlocksSelfContained(split);
  assertRebuilds(split, source);
});

test("原样 HTML 块与注释整体冻结，不会被切开", () => {
  const script = "<script>\nconst a = 1;\n\nconst b = 2;\n</script>\n\n后文";
  const scriptSplit = splitStreamingMarkdown(script);
  assert.equal(scriptSplit.blocks.length, 1, "脚本块被切成了多个块");
  assert.ok(scriptSplit.blocks[0].includes("</script>"), "脚本块没有完整冻结");
  assert.equal(scriptSplit.tail, "后文");
  assertBlocksSelfContained(scriptSplit);
  assertRebuilds(scriptSplit, script);

  const comment = "<!--\n注释内容\n\n更多注释\n-->\n\n后文";
  const commentSplit = splitStreamingMarkdown(comment);
  assert.equal(commentSplit.blocks.length, 1, "注释被切成了多个块");
  assert.ok(commentSplit.blocks[0].includes("-->"), "注释没有完整冻结");
  assertBlocksSelfContained(commentSplit);
  assertRebuilds(commentSplit, comment);
});

test("列表、引用续行与定义行不产生切点", () => {
  const list = "- 第一项\n  续行\n\n- 第二项\n";
  assert.deepEqual(splitStreamingMarkdown(list).blocks, []);

  const quote = "> 引用第一行\n> 引用第二行\n\n后文";
  assert.deepEqual(splitStreamingMarkdown(quote).blocks, []);

  // 引用式链接与脚注定义只能影响它之前的文本，所以定义必须和它前面的块待在一起。
  const definition = "段落。\n\n[ref]: https://example.com\n\n后文";
  const definitionSplit = splitStreamingMarkdown(definition);
  assert.deepEqual(definitionSplit.blocks, ["段落。\n\n[ref]: https://example.com\n\n"]);
  assert.equal(definitionSplit.tail, "后文");

  const footnote = "段落。\n\n[^1]: 脚注内容\n\n后文";
  const footnoteSplit = splitStreamingMarkdown(footnote);
  assert.deepEqual(footnoteSplit.blocks, ["段落。\n\n[^1]: 脚注内容\n\n"]);
  assert.equal(footnoteSplit.tail, "后文");
});

test("缩进代码块内部的空行不产生切点", () => {
  const source = "段落。\n\n    const a = 1;\n\n    const b = 2;\n\n尾部";
  const split = splitStreamingMarkdown(source);
  assert.ok(!split.blocks.join("").includes("const a = 1;"), "缩进代码块被切断");
  assertRebuilds(split, source);
});

test("空文本与无空行文本退化为整段尾部", () => {
  assert.deepEqual(splitStreamingMarkdown(""), { blocks: [], tail: "", openFence: null });
  const single = "一整段没有空行的文字，持续增长";
  const split = splitStreamingMarkdown(single);
  assert.deepEqual(split.blocks, []);
  assert.equal(split.tail, single);
});

test("CRLF 文本同样按原样切分", () => {
  const source = "第一段。\r\n\r\n第二段。\r\n\r\n```ts\r\nconst a = 1;\r\n```\r\n";
  const split = splitStreamingMarkdown(source);
  assertRebuilds(split, source);
  assert.equal(split.openFence, null);
  assertBlocksSelfContained(split);
  // 围栏后面没有新内容，所以代码块整体留在尾部，不能被块边界切开。
  assert.equal(scanStructure(split.tail).fence, null);
  assert.ok(!split.blocks.some((block) => block.includes("const a = 1;")));
});
