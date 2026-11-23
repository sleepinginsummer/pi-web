import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

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
const { isOutlineAnchorMessage, AssistantOutline, ChatMinimap, cachedAssistantAnswer, canLocateAnswerHeadings, getAssistantAnswer, getAssistantAnswerMarkdown } = await jiti.import("./ChatMinimap.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { carryMessageKeys, messageRenderKeys } = await jiti.import("@/lib/message-keys");
const { mergeBranchTailEntryIds } = await jiti.import("@/lib/idle-message-read");
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

  // 展开状态是「悬停」「钉住」「移动端抽屉」的并集，渲染与取大纲都看它。
  assert.match(source, /const previewOpen = minimapHovered \|\| previewPinned \|\| variant === "sheet";/);
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

test("移动端抽屉：同一份大纲摊成底部抽屉，空会话给一句说明，点背景关闭", () => {
  const emptyProps = {
    sessionId: "s1",
    leafId: null,
    messages: [],
    entryIds: [],
    getStreamingMessage: () => null,
    isStreaming: false,
    scrollContainer: { current: null },
    messageRefs: { current: [] },
    onRevealHistory() {},
    turnsBefore: 0,
    turnAnchors: [],
    variant: "sheet",
    onClose() {},
  };
  const wrap = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
  const empty = wrap(React.createElement(ChatMinimap, emptyProps));
  assert.match(empty, /data-sheet="true"/, "抽屉形态");
  assert.doesNotMatch(empty, /class="pill"/, "抽屉里不出现轨道胶囊");
  // 空会话要有说明（文案随语言，断言「渲染出了非空说明」而不是某一种文案）。
  assert.match(empty, /class="emptyState">[^<]+</, "空会话要说清楚，不能点开像没反应");
  assert.match(source, /<div className=\{styles\.emptyState\}>\{t\("chatMinimap\.noTurns"\)\}<\/div>/);

  // 抽屉只在打开时挂载；轨道形态下没有轮次照样不渲染。
  const rail = wrap(React.createElement(ChatMinimap, { ...emptyProps, variant: undefined }));
  assert.equal(rail, "");

  // 点抽屉内部（轮次、搜索框）不能冒泡到背景把抽屉关掉。
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(source, /data-sheet=\{variant === "sheet" \? "true" : undefined\}/);
  assert.match(source, /onClick=\{variant === "sheet" \? onClose : undefined\}/);
});

test("待定位目标按当前 DOM 量，不用缓存偏移", async () => {
  // 翻页刚挂进来的消息经 messageRefs 量不到，缓存偏移是 null；只读它会让「回到目标轮次」
  // 一直干等。这里必须按 data-entry-id 找元素、用 getBoundingClientRect 算位置。
  const pending = source.slice(
    source.indexOf("const pendingNavigation = pendingNavigationRef.current;"),
    source.indexOf("    }, 100);"),
  );
  assert.match(source, /function findTurnElement\(scrollEl: HTMLElement, entryId: string \| null \| undefined\)[\s\S]*?scrollEl\.querySelector<HTMLElement>\(`\[data-entry-id="\$\{CSS\.escape\(entryId\)\}"\]`\)/);
  assert.match(pending, /const targetElement = findTurnElement\(scrollEl, entryId\);/);
  assert.match(pending, /targetTop = elementScrollTop\(scrollEl, targetElement\);/);
  // 缓存偏移只作兜底：元素还不在 DOM 里时才用。
  const fallbackAt = pending.indexOf("pendingNode?.targetTurn.scrollTop != null");
  const domAt = pending.indexOf("elementScrollTop(scrollEl, targetElement)");
  assert.ok(domAt > 0 && fallbackAt > domAt, "DOM 测量在前，缓存偏移在后");
  // 一直量不到要提示，而不是静默挂着。
  assert.match(pending, /setRevealFailed\(true\)/);

  // 已加载轮次的双击跳转走同一份规则：先量 DOM，再退回缓存偏移。
  const scrollToNode = source.slice(source.indexOf("const scrollToNode = useCallback"), source.indexOf("const scrollToHeading = useCallback"));
  assert.match(scrollToNode, /elementScrollTop\(scrollEl, findTurnElement\(scrollEl, node\.targetTurn\.entryId\)\)/);
  assert.ok(scrollToNode.indexOf("elementScrollTop") < scrollToNode.indexOf("?? node.targetTurn.scrollTop"), "DOM 在前，缓存偏移在后");
});

test("未加载轮次按 entryId 判定，不再拿轮次号与轮次个数比", () => {
  // 大纲只列用户提问后编号会跳号（1、2、5、9…），turnsBefore 是轮次个数：
  // 用 `turnNumber <= turnsBefore` 会把后面的提问整段截掉（真机里 65 轮只剩约 40 行）。
  assert.doesNotMatch(source, /turn\.turnNumber <= turnsBefore/);
  assert.match(source, /outlineForView\.turns\.filter\(\(turn\) => !loadedIdSet\.has\(turn\.entryId\)\)/);
});

test("大纲只列用户提问：自定义消息与合成的分支摘要都不算", () => {
  const custom = (customType) => ({ role: "custom", customType, content: "x", display: true });
  assert.equal(isOutlineAnchorMessage({ role: "user", content: "问题" }), true);
  // 分支摘要渲染成用户消息，靠 synthetic 标记认出来。
  assert.equal(isOutlineAnchorMessage({ role: "user", content: "摘要", synthetic: "branch_summary" }), false);
  for (const type of ["pi-web:background-command", "pi-web:scheduled-task", "pi-web:subagent-report", "compaction", "shadow-mind-event"]) {
    assert.equal(isOutlineAnchorMessage(custom(type)), false, type);
  }
});

for (const { variant, historyFirst = false, noLoadedQuestions = false, noHistory = false, metadataLeaf = false, optimistic = false, idleAppend = false, startsWithReply = false, retryAtTop = false, replyUnmounted = false } of [
  { variant: "rail" },
  { variant: "rail", startsWithReply: true },
  { variant: "rail", retryAtTop: true },
  { variant: "rail", retryAtTop: true, startsWithReply: true, replyUnmounted: true },
  { variant: "rail", retryAtTop: true, startsWithReply: true },
  { variant: "rail", noHistory: true },
  { variant: "rail", noHistory: true, optimistic: true },
  { variant: "sheet" },
  { variant: "sheet", idleAppend: true },
  { variant: "sheet", metadataLeaf: true },
  { variant: "sheet", metadataLeaf: true, idleAppend: true },
  { variant: "sheet", historyFirst: true },
  { variant: "sheet", historyFirst: true, noLoadedQuestions: true },
]) {
  const order = historyFirst ? "目录先返回" : "聊天先测量";
  const scenario = optimistic ? "新提问落盘" : idleAppend ? `短尾页接续刷新${metadataLeaf ? "（旧末尾是改名记录）" : ""}`
    : retryAtTop ? (replyUnmounted ? "跨页回复未挂载且页首只有重试提示" : startsWithReply ? "阅读线在已挂载跨页回复上方的重试提示内" : "页首只有加载重试提示") : startsWithReply ? "页首是跨页回复" : noHistory ? "钉住后刷新" : metadataLeaf ? "末尾是改名记录" : noLoadedQuestions ? "页内没有提问" : order;
  test(`${variant}：${scenario}时保留目录位置`, async (t) => {
    const { window } = new JSDOM("<!doctype html><div id='root'></div><div id='chat'></div>", { url: "http://localhost" });
    const { document } = window;
    const globals = {
      window, document, ResizeObserver: class { observe() {} disconnect() {} },
      CSS: { escape: (entryId) => entryId }, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.getOwnPropertyDescriptors(globalThis);
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.querySelector("#root"));
    t.after(async () => {
      await React.act(() => root.unmount());
      window.close();
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
        else delete globalThis[name];
      }
    });

    const chat = document.querySelector("#chat");
    Object.defineProperties(chat, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
    const readingOlderQuestion = variant === "rail" && !noHistory && !startsWithReply;
    const initialScrollTop = startsWithReply || retryAtTop ? 0 : readingOlderQuestion ? 100 : 400;
    chat.scrollTop = initialScrollTop;
    const reply = { role: "assistant", content: [{ type: "text", text: "跨页回复" }] };
    const questions = ["较早提问", "正在阅读的提问", "最新提问"].map((content) => ({ role: "user", content }));
    const messages = noLoadedQuestions ? [reply] : startsWithReply ? [reply, ...questions] : questions;
    const messageRefs = messages.map((_, index) => {
      if (replyUnmounted && index === 0) return null;
      const element = chat.appendChild(document.createElement("div"));
      element.getBoundingClientRect = () => ({ top: (retryAtTop ? 50 : 0) + index * 110 - chat.scrollTop });
      return element;
    });

    // 用固定行高模拟列表。旧目录插到前面时，每个已加载行的坐标都会改变。
    const getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
    t.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", function () {
      if (this.matches(".list")) return { top: 0, bottom: 40 };
      if (this.matches(".turnRow")) {
        const turn = this.parentElement;
        const list = turn.parentElement;
        const top = Array.from(list.children).indexOf(turn) * 20 - list.scrollTop;
        return { top, bottom: top + 20 };
      }
      return getBoundingClientRect.call(this);
    });

    const response = Promise.withResolvers();
    const refreshedResponse = Promise.withResolvers();
    const fetchOutline = t.mock.method(globalThis, "fetch", () => response.promise);
    fetchOutline.mock.mockImplementationOnce(() => refreshedResponse.promise, 1);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entryIds = startsWithReply ? ["previous-answer", "e5", "e6", "e7"] : noLoadedQuestions ? ["e7"] : optimistic ? ["e5", "e6"] : ["e5", "e6", "e7"];
    const aliases = new Map();
    const props = {
      variant, sessionId: "outline-test", leafId: metadataLeaf ? "session-info" : entryIds.at(-1),
      messages, entryIds, messageKeys: messageRenderKeys(entryIds, messages.length, aliases),
      scrollContainer: { current: chat }, messageRefs: { current: messageRefs },
      getStreamingMessage: () => null, isStreaming: false, onRevealHistory() {},
      turnsBefore: noHistory ? 0 : 4, turnAnchors: messages.map((message) => message.role === "user"),
    };
    await React.act(() => root.render(React.createElement(I18nProvider, null, React.createElement(ChatMinimap, props))));
    if (!historyFirst) await React.act(() => t.mock.timers.tick(100));
    if (variant === "rail") {
      const pill = document.querySelector("[data-minimap-pill]");
      if (noHistory) {
        await React.act(() => pill.querySelector("[data-minimap-lock]").click());
        await React.act(() => pill.click());
        assert.ok(document.querySelector("[data-minimap-preview-pinned]"));
      } else {
        await React.act(() => pill.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })));
      }
    }

    const turns = Array.from({ length: 4 }, (_, index) => ({ entryId: `e${index + 1}`, turnNumber: index + 1 }));
    await React.act(() => response.resolve({ ok: true, json: async () => ({ turns }) }));
    if (historyFirst) {
      assert.equal(document.querySelectorAll("[data-minimap-outline-entry]").length, 4);
      assert.equal(document.querySelectorAll("[data-minimap-preview-index]").length, 0);
      assert.equal(document.querySelector(".list").scrollTop, 0, "聊天测量前先保留列表位置");
      await React.act(() => t.mock.timers.tick(100));
    }

    const list = document.querySelector(".list");
    assert.equal(list.querySelectorAll("[data-minimap-outline-entry]").length, noHistory ? 0 : 4);
    const target = list.querySelector(noLoadedQuestions || (startsWithReply && !retryAtTop)
      ? "[data-minimap-outline-entry='e4'] button"
      : `[data-minimap-preview-index='${retryAtTop ? 0 : readingOlderQuestion ? 1 : 2}'] button`);
    const { top, bottom } = target.getBoundingClientRect();
    assert.ok(top >= 0 && bottom <= 40, `${variant} 的目标行位置为 ${top}–${bottom}`);
    assert.equal(chat.scrollTop, initialScrollTop);
    if (retryAtTop) {
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapPreviewIndex, "0", "顶部提示下方仍选首条已加载提问");
    }
    if (retryAtTop && startsWithReply && !replyUnmounted) {
      // 重试提示占 50px，100px 视口的阅读线在 30px。滚 20px 后刚好读到回复顶部。
      chat.scrollTop = 20;
      await React.act(() => chat.dispatchEvent(new window.Event("scroll")));
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapOutlineEntry, "e4");
      chat.scrollTop = 19;
      await React.act(() => chat.dispatchEvent(new window.Event("scroll")));
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapPreviewIndex, "0");
    }
    if (startsWithReply && !retryAtTop) {
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapOutlineEntry, "e4", "仍在阅读上一轮回复");
      chat.scrollTop = 110;
      await React.act(() => chat.dispatchEvent(new window.Event("scroll")));
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapPreviewIndex, "0", "读到下一问后切换高亮");
      chat.scrollTop = 0;
      await React.act(() => chat.dispatchEvent(new window.Event("scroll")));
      assert.equal(list.querySelector('[data-located="true"]').dataset.minimapOutlineEntry, "e4", "向上读回跨页回复时恢复历史高亮");
    }

    if ((variant === "sheet" && !historyFirst) || noHistory) {
      const manualScrollTop = noHistory ? 0 : 20;
      list.scrollTop = manualScrollTop;
      const persisted = {
        entryIds: ["e5", "e6", "e7", "answer"],
        messages: [...messages, { role: "assistant", content: [{ type: "text", text: "回复完成" }] }],
      };
      await React.act(() => root.render(React.createElement(I18nProvider, null, React.createElement(ChatMinimap, {
        ...props,
        ...(noHistory ? {
          ...persisted, leafId: "answer",
          messageKeys: messageRenderKeys(persisted.entryIds, persisted.messages.length, carryMessageKeys({ ...props, aliases }, persisted)),
          turnAnchors: [...props.turnAnchors, false],
        } : { entryIds: [...props.entryIds] }),
      }))));
      await React.act(() => t.mock.timers.tick(100));
      assert.equal(list.scrollTop, manualScrollTop, "刷新同一份历史时保留手动滚动位置");
      if (noHistory) {
        list.scrollTop = 20;
        chat.scrollTop = 0;
        await React.act(() => chat.dispatchEvent(new window.Event("scroll")));
        assert.equal(list.scrollTop, 0, "聊天切到另一问时仍会对齐大纲");
        return;
      }

      // 最终回复推进 leaf 时，目录会重新请求。请求期间保留旧行，返回后也不再自动定位。
      const answerTail = [...props.entryIds, ...(metadataLeaf ? ["session-info"] : []), "answer"];
      await React.act(() => root.render(React.createElement(I18nProvider, null, React.createElement(ChatMinimap, {
        ...props, leafId: "answer", entryIds: [...props.entryIds, "answer"],
        branchTailEntryIds: answerTail,
        messages: [...messages, { role: "assistant", content: [{ type: "text", text: "回复完成" }] }],
        turnAnchors: [...props.turnAnchors, false],
      }))));
      assert.equal(list.querySelectorAll("[data-minimap-outline-entry]").length, 4);
      assert.equal(list.scrollTop, 20);
      assert.equal(fetchOutline.mock.callCount(), 2);
      if (idleAppend) {
        const nextResponse = Promise.withResolvers();
        fetchOutline.mock.mockImplementationOnce(() => nextResponse.promise, 2);
        const extension = { role: "custom", customType: "idle-extension", content: "扩展消息", display: true };
        await React.act(() => root.render(React.createElement(I18nProvider, null, React.createElement(ChatMinimap, {
          ...props, leafId: "extension", entryIds: [...persisted.entryIds, "extension"],
          branchTailEntryIds: metadataLeaf ? mergeBranchTailEntryIds("answer", answerTail, ["answer", "extension"]) : ["answer", "extension"],
          messages: [...persisted.messages, extension],
          turnAnchors: [...props.turnAnchors, false, true],
        }))));
        assert.equal(list.querySelectorAll("[data-minimap-outline-entry]").length, 4, "短尾页刷新期间保留已加载历史");
        assert.equal(list.scrollTop, 20);
        assert.equal(fetchOutline.mock.callCount(), 3);
        await React.act(() => nextResponse.resolve({ ok: true, json: async () => ({ turns }) }));
      }
      await React.act(() => refreshedResponse.resolve({ ok: true, json: async () => ({ turns: turns.map((turn) => ({ ...turn })) }) }));
      await React.act(() => t.mock.timers.tick(100));
      assert.equal(list.scrollTop, 20, "新目录返回后仍保留手动滚动位置");
      if (metadataLeaf) {
        fetchOutline.mock.mockImplementationOnce(() => Promise.withResolvers().promise, fetchOutline.mock.callCount());
        await React.act(() => root.render(React.createElement(I18nProvider, null, React.createElement(ChatMinimap, {
          ...props, leafId: "other-branch", branchTailEntryIds: [...props.entryIds, "other-branch"],
        }))));
        assert.equal(list.querySelectorAll("[data-minimap-outline-entry]").length, 0, "切到旁支时不复用旧目录");
      }
    }
  });
}
