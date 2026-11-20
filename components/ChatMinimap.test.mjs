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
const { AssistantOutline, canLocateAnswerHeadings, getAssistantAnswerMarkdown } = await jiti.import("./ChatMinimap.tsx");
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
  // 历史翻完（turnsBefore 归零）时被取消的请求不会自己收尾，这里要清掉加载态。
  assert.match(source, /setOutlineLoading\(false\);\s*\n\s*return;/);
});

test("大纲标题判定与跳转挂载都走主对话同一套规则", () => {
  // Setext（=== / ---）标题同样要算标题：判定来自共享扫描器，不是只认 # 的正则。
  assert.match(source, /import \{ cachedHasOutlineHeadings, hasOutlineHeadings, joinAnswerBlocks \} from "@\/lib\/outline-headings";/);
  // 判定结果按正文缓存：滚动重测会新建 allNodes，内容没变就不必重扫。
  assert.match(source, /const \[headingScanCache\] = useState\(\(\) => new Map<string, boolean>\(\)\);/);
  assert.match(source, /cachedHasOutlineHeadings\(headingScanCache, finalAssistant\.markdown\)/);
  assert.match(source, /headingScanCache\.clear\(\);/);
  // 流式正文每帧都变，进缓存只会占位并挤掉别的回答：它直接扫、不写缓存。
  assert.match(source, /finalAssistant\?\.streaming\s*\n\s*\? hasOutlineHeadings\(finalAssistant\.markdown\)/);
  assert.match(source, /streamingMessage && messageIndex === allMessages\.length - 1 \? \{ streaming: true \}/);
  // 标题判定只按 allNodes 扫一次，渲染循环里不再逐轮重扫整段回答。
  assert.match(source, /const nodesWithHeadings = useMemo\(\(\) => \{/);
  assert.match(source, /const hasHeadings = nodesWithHeadings\.has\(node\.index\);/);
  assert.doesNotMatch(source, /Boolean\(finalAssistant && hasOutlineHeadings\(finalAssistant\.markdown\)\)/);
  // 跳转只认最终回答里带标记的顶层标题：过程详情、引用块、原样 HTML 的标题都不算，
  // 否则预览的编号和正文里的 h1/h2 数量对不上，会跳到另一段。
  assert.match(source, /const ANSWER_HEADING_SELECTOR = "\[data-answer-heading\]";/);
  // 过程与答复分开渲染时，先认 ChatWindow 给答复加的 data-answer 容器，再退回含标记的节点。
  assert.match(source, /const ANSWER_CONTAINER_SELECTOR = "\[data-answer\]";/);
  assert.match(source, /roots\.find\(\(root\) => root\.matches\(ANSWER_CONTAINER_SELECTOR\)\)/);
  assert.match(source, /roots\.find\(\(root\) => root\.querySelector\(ANSWER_HEADING_SELECTOR\)\)/);
  assert.match(source, /const heading = answerHeadingElements\(answerElement\)\[headingIndex\];/);
  assert.doesNotMatch(source, /querySelectorAll<HTMLElement>\("h1, h2"\)/);
  assert.doesNotMatch(source, /\^\\s\*#\{1,2\}/);
  // 长会话只挂载最近一段消息组：跳转要把目标轮交给上层挂进渲染窗口，
  // 否则滚动定位永远等不到节点，点大纲像没反应。
  assert.match(source, /onRevealHistory: \(entryId\?: string\) => void;/);
  assert.match(source, /onRevealHistory\(turn\.entryId\);/);
  assert.match(source, /onRevealHistory\(node\.targetTurn\.entryId\);/);
});

test("大纲的最终回答按正文的块边界拼接，并认识纯图片回答", async () => {
  const { extractOutlineHeadings } = await jiti.import("../lib/outline-headings.ts");
  const answer = (content) => ({ role: "assistant", content });

  // 第一块漏写闭合围栏：正文里第二块单独渲染，第二块的标题照样可见，大纲也要列出来。
  const markdown = getAssistantAnswerMarkdown(answer([
    { type: "text", text: "说明：\n\n```ts\nconst x = 1;" },
    { type: "text", text: "## 结论\n\n正文。" },
  ]));
  assert.equal(typeof markdown, "string");
  assert.deepEqual(extractOutlineHeadings(markdown), [{ level: 2, text: "结论" }]);

  // 块末尾是“看着像闭合”的混合围栏（```~~~）时，Markdown 解析器仍认为围栏开着：
  // 拼接时补上关闭行，预览才能把这个标题渲染成可点的按钮。
  const mixed = getAssistantAnswerMarkdown(answer([
    { type: "text", text: "```\ncode\n```~~~" },
    { type: "text", text: "## 结论" },
  ]));
  const outline = renderToStaticMarkup(React.createElement(AssistantOutline, { markdown: mixed, onHeadingClick() {} }));
  assert.match(outline, /data-preview-heading-index="0"/);
  assert.match(outline, /结论/);

  // 纯图片回答也是回答：返回空正文，把上一段过程回复的标题清掉。
  assert.equal(getAssistantAnswerMarkdown(answer([{ type: "image", data: "AA==", mimeType: "image/png" }])), "");
  // 只有工具调用的过程回复还不算回答。
  assert.equal(getAssistantAnswerMarkdown(answer([{ type: "toolCall", id: "t1", name: "read", arguments: {} }])), null);
  assert.equal(getAssistantAnswerMarkdown({ role: "user", content: "问题" }), null);
});

test("标题只在正文里定位得到时才可点", () => {
  // 已经挂载：要求那份副本里真有标记（流式气泡、没打标记的渲染入口都拿不到）。
  assert.equal(canLocateAnswerHeadings({ element: null, entryId: "e1" }), true, "还没挂载但能按 entryId 挂进来");
  assert.equal(canLocateAnswerHeadings({ element: null }), false, "没有 entryId 的流式气泡先不给点");
  assert.equal(canLocateAnswerHeadings(null), false);
  const marked = { querySelector: () => ({ tagName: "H2" }) };
  const unmarked = { querySelector: () => null };
  assert.equal(canLocateAnswerHeadings({ element: marked, entryId: "e1" }), true);
  assert.equal(canLocateAnswerHeadings({ element: unmarked, entryId: "e1" }), false, "挂载了但副本没打标记，点了也是空转");

  // 渲染时按这个判断决定是否给 onClick：没有回调的标题会渲染成 disabled。
  assert.match(source, /onHeadingClick=\{canLocateAnswerHeadings\(finalAssistant\) \?/);
});
