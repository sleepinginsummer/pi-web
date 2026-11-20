import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AssistantOutline } = await jiti.import("./ChatMinimap.tsx");
const source = await readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8");

test("renders math in headings without disabling heading navigation", () => {
  const html = renderToStaticMarkup(
    React.createElement(AssistantOutline, {
      markdown: String.raw`# Inline $f_{k,t+1}$

## Parentheses \(x^2 + y^2\)`,
      onHeadingClick() {},
    }),
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /data-preview-heading-index="0"/);
  assert.match(html, /data-preview-heading-index="1"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("流式尺寸变化不触发 Minimap 全量消息测量", () => {
  assert.match(source, /if \(!isStreaming\) measureNodes\(\);/);
  assert.match(source, /getStreamingMessage: \(\) => Partial<AgentMessage> \| null/);
  assert.match(source, /isStreaming: boolean/);
});


test("1-A 大纲仅提取 h1/h2 标题并忽略 h3 与普通段落", () => {
  const html = renderToStaticMarkup(
    React.createElement(AssistantOutline, {
      markdown: "# 一级\n\n普通正文\n\n## 二级\n\n### 三级不展示",
      onHeadingClick() {},
    }),
  );

  assert.match(html, /一级/);
  assert.match(html, /二级/);
  assert.doesNotMatch(html, /三级不展示/);
  assert.doesNotMatch(html, /普通正文/);
});

test("方案 A 大纲支持全量接口按需拉取与单击展开/双击跳转", () => {
  assert.match(source, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/outline/);
  assert.match(source, /onDoubleClick=\{\(\) => scrollToNode\(node, "smooth"\)\}/);
  assert.match(source, /onDoubleClick=\{\(\) => void jumpToUnloadedTurn\(turn\)\}/);
});

test("大纲标题判定与跳转挂载都走主对话同一套规则", () => {
  // Setext（=== / ---）标题同样要算标题：判定来自共享扫描器，不是只认 # 的正则。
  assert.match(source, /import \{ hasOutlineHeadings \} from "@\/lib\/outline-headings";/);
  assert.match(source, /const hasHeadings = Boolean\(finalAssistant && hasOutlineHeadings\(finalAssistant\.markdown\)\);/);
  assert.doesNotMatch(source, /\^\\s\*#\{1,2\}/);
  // 长会话只挂载最近一段消息组：跳转要把目标轮交给上层挂进渲染窗口，
  // 否则滚动定位永远等不到节点，点大纲像没反应。
  assert.match(source, /onRevealHistory: \(entryId\?: string\) => void;/);
  assert.match(source, /onRevealHistory\(turn\.entryId\);/);
  assert.match(source, /onRevealHistory\(node\.targetTurn\.entryId\);/);
});
