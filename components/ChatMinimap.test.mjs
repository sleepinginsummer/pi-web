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
const { AssistantOutline, cachedAssistantAnswer, canLocateAnswerHeadings, getAssistantAnswer, getAssistantAnswerMarkdown } = await jiti.import("./ChatMinimap.tsx");
const source = await readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8");
const bodySource = await readFile(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");
const messageSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("renders math in headings without disabling heading navigation", () => {
  const html = renderToStaticMarkup(
    React.createElement(AssistantOutline, {
      blocks: [{
        blockIndex: 0,
        text: String.raw`# Inline $f_{k,t+1}$

## Parentheses \(x^2 + y^2\)`,
      }],
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
      blocks: [{ blockIndex: 0, text: "# 一级\n\n普通正文\n\n## 二级\n\n### 三级不展示" }],
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
  // 逐块判定：预览也按块渲染，拼接后才出现的标题不该让折叠箭头出现。
  assert.match(source, /cachedHasOutlineHeadings\(headingScanCache, block\.text\)/);
  assert.match(source, /headingScanCache\.clear\(\);/);
  // 流式正文每帧都变，进缓存只会占位并挤掉别的回答：它直接扫、不写缓存。
  assert.match(source, /\? hasOutlineHeadings\(block\.text\)/);
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
  // 预览按块渲染后，点击定位是「块下标 + 块内标题下标」：先找块，再取块内第几个标题。
  assert.match(source, /answerElement\.querySelector<HTMLElement>\(`\[data-answer-block="\$\{headingBlockIndex\}"\]`\)/);
  assert.match(source, /const heading = \(blockElement \? answerHeadingElements\(blockElement\) : answerHeadingElements\(answerElement\)\)\[headingIndex\];/);
  // 正文里每个回答文本块的根节点带自己的块下标，定位时靠它把块对上。
  assert.match(bodySource, /data-answer-block=\{answerBlockIndex\}/);
  assert.match(messageSource, /answerBlockIndex=\{blockIndex\}/);
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
  const mixed = getAssistantAnswer(answer([
    { type: "text", text: "```\ncode\n```~~~" },
    { type: "text", text: "## 结论" },
  ]));
  const outline = renderToStaticMarkup(React.createElement(AssistantOutline, { blocks: mixed.blocks, onHeadingClick() {} }));
  assert.match(outline, /data-preview-heading-index="0"/);
  assert.match(outline, /结论/);

  // 纯图片回答也是回答：返回空正文，把上一段过程回复的标题清掉。
  assert.equal(getAssistantAnswerMarkdown(answer([{ type: "image", data: "AA==", mimeType: "image/png" }])), "");
  // 只有工具调用的过程回复还不算回答。
  assert.equal(getAssistantAnswerMarkdown(answer([{ type: "toolCall", id: "t1", name: "read", arguments: {} }])), null);
  assert.equal(getAssistantAnswerMarkdown({ role: "user", content: "问题" }), null);
});

test("第二块以缩进标题开头时，预览按块给出标题，编号与正文一致", async () => {
  const { extractOutlineHeadings } = await jiti.import("../lib/outline-headings.ts");
  const answer = (content) => ({ role: "assistant", content });
  const parsed = getAssistantAnswer(answer([
    { type: "text", text: "下面几点：\n\n- 第一点\n- 第二点" },
    { type: "text", text: "  ## 标题甲\n\n正文\n\n## 标题乙" },
  ]));

  // 拼接整篇时，第二块那个两格缩进的标题会被并进前一块的列表里 —— 所以拼接结果
  // 不能拿来编号，正文本来也是逐块渲染的。
  assert.deepEqual(extractOutlineHeadings(parsed.markdown).map((heading) => heading.text), ["标题乙"]);

  const html = renderToStaticMarkup(React.createElement(AssistantOutline, {
    blocks: parsed.blocks,
    onHeadingClick() {},
  }));
  assert.match(html, /标题甲/, "正文里能点到的标题，预览也要列出来");
  assert.match(html, /标题乙/);
  // 编号按块各自从 0 开始：这一块里的两个标题是 0 / 1。
  assert.equal((html.match(/data-preview-heading-index="0"/g) ?? []).length, 1);
  assert.equal((html.match(/data-preview-heading-index="1"/g) ?? []).length, 1);

  // 两块各有一个标题时，两块都从 0 编号 —— 点击时用「块下标 + 块内下标」定位。
  const split = getAssistantAnswer(answer([
    { type: "text", text: "## 第一块标题" },
    { type: "text", text: "## 第二块标题" },
  ]));
  const splitHtml = renderToStaticMarkup(React.createElement(AssistantOutline, {
    blocks: split.blocks,
    onHeadingClick() {},
  }));
  assert.match(splitHtml, /第一块标题/);
  assert.match(splitHtml, /第二块标题/);
  assert.equal((splitHtml.match(/data-preview-heading-index="0"/g) ?? []).length, 2);
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
  assert.match(source, /onHeadingClick=\{canLocateAnswerHeadings\(finalAssistant\)\s*\n\s*\? \(blockIndex, headingIndex\) => scrollToHeading\(node, blockIndex, headingIndex\)/);
});

test("锁定浮层后仍能展开：悬停不展开，点胶囊钉住", () => {
  // 锁定的语义（#1128）是「悬停不展开」，保留这条守卫。
  const showPreview = source.slice(
    source.indexOf("const showPreview = useCallback"),
    source.indexOf("const enterPreview = useCallback"),
  );
  assert.match(showPreview, /if \(locked\) return;/);

  // 锁定后没有入口就成了死功能：点胶囊钉住浮层，再点收起。
  const togglePinned = source.slice(
    source.indexOf("const togglePreviewPinned = useCallback"),
    source.indexOf("useEffect(() => () => cancelPreviewHide()"),
  );
  assert.match(togglePinned, /if \(!locked\) return;/);
  assert.match(togglePinned, /setPreviewPinned\(\(current\) => !current\);/);
  assert.match(source, /onClick=\{togglePreviewPinned\}/);
  assert.match(source, /title=\{locked \? t\("chatMinimap\.pinPreview"\) : undefined\}/);

  // 展开状态是「悬停」或「钉住」的并集，渲染与取大纲都看它。
  assert.match(source, /const previewOpen = minimapHovered \|\| previewPinned;/);
  assert.match(source, /\{previewOpen && totalTurnCount > 0 && \(/);
  assert.match(source, /if \(!previewOpen \|\| !sessionId \|\| turnsBefore <= 0\) \{/);
  assert.doesNotMatch(source, /\{minimapHovered && totalTurnCount > 0 && \(/);

  // 钉住的那份不随鼠标离开自动收起。
  assert.match(source, /if \(searchFocusedRef\.current \|\| previewPinned\) return;/);
  // 上锁/解锁把两种展开状态都清掉，不互相残留。
  const toggleLock = source.slice(
    source.indexOf("const toggleLock = useCallback"),
    source.indexOf("const togglePreviewPinned = useCallback"),
  );
  assert.match(toggleLock, /setMinimapHovered\(false\);/);
  assert.match(toggleLock, /setPreviewPinned\(false\);/);
});

test("搜索框失焦后浮层能收起，指针还在浮层里时不收", () => {
  // 聚焦标记只挡定时器，失焦时要主动调度一次收起，否则浮层常驻。
  const blur = source.slice(
    source.indexOf("onBlur={() => {"),
    source.indexOf("placeholder={t(\"chatMinimap.searchPlaceholder\""),
  );
  assert.match(blur, /searchFocusedRef\.current = false;/);
  assert.match(blur, /if \(!hoveringRef\.current\) schedulePreviewHide\(\);/);
  // 悬停标记由胶囊/浮层进入离开时维护，点击浮层内的标题不会把自己关掉。
  assert.match(source, /hoveringRef\.current = true;/);
  assert.match(source, /hoveringRef\.current = false;/);
  assert.match(source, /onMouseEnter=\{enterPreview\}/);
  assert.match(source, /onMouseLeave=\{leavePreview\}/);
  assert.match(source, /if \(!searchFocusedRef\.current && !hoveringRef\.current\) setMinimapHovered\(false\);/);
});

test("每次测量复用同一条回答的提取结果", () => {
  // 测量在挂载、滚动、尺寸变化时都会跑；回答没变就不该重新拼一遍 Markdown。
  const message = { role: "assistant", content: [{ type: "text", text: "## 标题\n\n正文" }] };
  const first = cachedAssistantAnswer(message);
  assert.equal(cachedAssistantAnswer(message), first, "同一个消息对象只算一次");
  assert.equal(first.markdown, "## 标题\n\n正文");

  // blocks 的引用稳定，大纲预览的 memo 才能命中。
  assert.equal(cachedAssistantAnswer(message).blocks, first.blocks);

  // 内容变了就是新对象（消息本身不可变，正常路径不会原地改）。
  const updated = { role: "assistant", content: [{ type: "text", text: "## 新标题" }] };
  assert.notEqual(cachedAssistantAnswer(updated), first);
  assert.deepEqual(cachedAssistantAnswer(updated).blocks.map((block) => block.text), ["## 新标题"]);

  // 非助手消息也缓存 null，反复测量不再重复判断。
  const user = { role: "user", content: "问题" };
  assert.equal(cachedAssistantAnswer(user), null);
  assert.equal(cachedAssistantAnswer(user), null);
});

test("按需加载的跳转在切会话/分支后作废", () => {
  const jump = source.slice(
    source.indexOf("const jumpToUnloadedTurn = useCallback"),
    source.indexOf("const cancelPreviewHide = useCallback"),
  );
  // 加载是异步的：回来时可能已经切到别的分支，结果属于旧分支。
  // 旧跳转收尾只清自己写进去的目标，不碰新跳转刚设置的那一份。
  assert.match(jump, /if \(jumpTargetRef\.current !== turn\.entryId\) \{\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(pendingNavigationRef\.current\?\.entryId === turn\.entryId\) pendingNavigationRef\.current = null;/);
  // 失败提示只在目标仍然是当前目标时出现（旧写法把这条守卫放在 else 里）。
  assert.doesNotMatch(jump, /if \(jumpTargetRef\.current === turn\.entryId\) setRevealFailed\(true\);/);
  // finally 不能清掉新一次跳转的加载态。
  assert.match(jump, /if \(jumpTargetRef\.current === turn\.entryId\) \{\s*\n\s*jumpTargetRef\.current = null;\s*\n\s*setLoadingEntryId\(null\);/);
  // 切换会话/分支时也清掉待定位目标。
  const reset = source.slice(
    source.indexOf("// 切换会话或分支时清空大纲本地筛选与展开状态。"),
    source.indexOf("// 打开大纲且存在未加载历史时"),
  );
  assert.match(reset, /jumpTargetRef\.current = null;/);
  assert.match(reset, /pendingNavigationRef\.current = null;/);
});
