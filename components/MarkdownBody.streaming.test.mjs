import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, { cwd: "/tmp", onOpenFile() {}, ...props }, markdown),
    ),
  );
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * 流式路径把文本切成多个 ReactMarkdown，块与块之间的空行不再生成空白文本节点。
 * 这些节点渲染上不可见（`.markdown-body` 不设置 white-space），比较时统一折叠。
 */
function collapseBlockWhitespace(html) {
  return html.replace(/>\s+</g, "><");
}

// 顶层结构：标题、段落、列表、表格、代码围栏、引用、展示数学。
const document = [
  "# 标题",
  "",
  "第一段说明文字，包含 `inline code` 与 **粗体**。",
  "",
  "- 列表项一",
  "  列表项续行",
  "- 列表项二",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| a | b |",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "$$",
  "x = 1",
  "$$",
  "",
  "结尾段落。",
].join("\n");

test("流式分块渲染与非流式整篇渲染输出一致", () => {
  const full = renderMarkdown(document);
  const streaming = renderMarkdown(document, { isStreaming: true });

  assert.equal(collapseBlockWhitespace(streaming), collapseBlockWhitespace(full));
});

test("未闭合围栏在两条路径下都按纯文本渲染且输出一致", () => {
  const open = "说明文字。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
  const full = renderMarkdown(open);
  const streaming = renderMarkdown(open, { isStreaming: true });

  assert.match(streaming, /markdown-code-plain/);
  assert.equal(collapseBlockWhitespace(streaming), collapseBlockWhitespace(full));
});

test("流式快照不会丢失已收到的内容", () => {
  const paragraphs = [
    "第一段文字，逐字增长。",
    "第二段文字，继续增长。",
    "第三段文字，仍然增长。",
    "第四段文字，最后一段。",
  ];
  const source = paragraphs.join("\n\n") + "\n";

  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    const html = renderMarkdown(prefix, { isStreaming: true });
    const visible = stripTags(html);
    // 最新一段（可能还没写完）必须出现在渲染结果里。
    const latestParagraph = prefix.split(/\n\n/).pop() ?? "";
    assert.ok(
      visible.includes(latestParagraph.trim()),
      `第 ${end} 个字符的快照丢失了尾部内容：${JSON.stringify(latestParagraph)}`,
    );
  }
});

test("流式路径的块级缓存契约在源码里保持", () => {
  const source = readFileSync(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");

  assert.match(source, /const StreamingMarkdownBlock = memo\(/, "前缀块必须用 memo 跳过重复解析");
  assert.match(source, /if \(isBlock\) return renderCodeBlock\(raw, lang, isStreaming\);/, "代码块渲染要复用同一分支");
  assert.match(source, /splitStreamingMarkdown\(normalizedMarkdown\)/, "流式路径要使用分块器");
  // 上游回调换身份时不能让 components 换身份，否则块级 memo 永远不命中。
  assert.doesNotMatch(source, /\}\), \[cwd, isStreaming, onOpenFile\]\)/, "components 依赖里不能直接放回调");
});
