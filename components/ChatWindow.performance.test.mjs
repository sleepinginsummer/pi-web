import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("长会话渲染索引通过一次线性 memo 复用", () => {
  const indexSource = source.slice(
    source.indexOf("  const messageRenderIndex = useMemo"),
    source.indexOf("  const inputHistory = useMemo"),
  );
  const renderSource = source.slice(
    source.indexOf("            {(() => {"),
    source.indexOf("            })()}", source.indexOf("            {(() => {")),
  );

  assert.match(indexSource, /const toolResults = new Map/);
  assert.match(indexSource, /const visibleRefIndexByMessage = new Map/);
  assert.match(indexSource, /const writtenFilesByFinalAssistant = new Map/);
  assert.match(indexSource, /for \(let index = 0; index < messages\.length; index\+\+\)/);
  assert.match(indexSource, /\}, \[activeToolResults, messageCwd, messages, turnAnchors\]\);/);
  assert.doesNotMatch(indexSource, /buildMessageRenderGroups/);
  assert.match(renderSource, /const \{ toolResults, visibleRefIndexByMessage, writtenFilesByFinalAssistant \} = messageRenderIndex/);
  assert.doesNotMatch(renderSource, /for \(let j = idx \+ 1; j < messages\.length; j\+\+\)/);
  assert.doesNotMatch(renderSource, /new Map<string, ToolResultMessage>/);
});

test("助手消息显示时间，流式尾消息隐藏时间并允许分段覆盖", () => {
  const renderMessageSource = source.slice(
    source.indexOf("              const renderMessage ="),
    source.indexOf("              const renderGroup ="),
  );
  assert.match(renderMessageSource, /let showTimestamp = msg\.role === "assistant";/);
  assert.match(renderMessageSource, /if \(showTimestamp && isStreaming && idx === messages\.length - 1\) \{\s*showTimestamp = false;/);
  assert.match(renderMessageSource, /if \(options\.showTimestamp !== undefined\) showTimestamp = options\.showTimestamp;/);
  assert.match(renderMessageSource, /showTimestamp=\{showTimestamp\}/);
});

test("过程与答复拆分后只在答复显示同一条助手消息的时间", () => {
  // 过程副本被正文段落切开后，只有那段「切片的最后一块」带时间，且最终答复的答复副本不带。
  assert.match(source, /const sliceShowTimestamp = isLastSlice && \(processIdx !== finalAssistantIdx \|\| !finalAnswerMessage\);/);
  assert.match(source, /if \(finalAnswerMessage\) nodes\.push\(renderMessage\(finalAssistantIdx, \{\s*messageOverride: finalAnswerMessage, writtenFiles,/);
  // 答复那一次渲染在容器上留标记：大纲跳转据此在同一条消息的过程副本里挑对节点。
  assert.match(source, /data-answer=\{options\.finalAnswer \? "1" : undefined\}/);
});

test("本地渲染窗口耗尽后继续请求服务端历史页", () => {
  assert.match(source, /MAX_MOUNTED_HISTORY_GROUPS/);
  assert.match(source, /groupWindow\.start > 0/);
  assert.match(source, /hasEarlierMessages && !loadingEarlierMessages/);
  assert.match(source, /void loadEarlierMessages\(\)/);
  assert.match(source, /const hasMore = boundedStartIndex > 0 \|\| hasEarlierMessages/);
  assert.match(source, /groups\.slice\(boundedStartIndex, endIndex\)/);
});

test("折叠的过程详情只在展开时构造，不在每次渲染时提前造 JSX", () => {
  // 20 轮 × 20 步的会话里，折叠态每帧都造几百个元素和闭包是白费。
  assert.doesNotMatch(source, /const processViews: ReactNode\[\] = \[\];/);
  // 过程描述按正文段落切成多段（`seg.descriptors`），每段各自构造自己的节点。
  assert.match(source, /const renderProcessViews = \(\): ReactNode => seg\.descriptors\.map/);
  assert.match(source, /renderChildren=\{\(\) => <>\{renderProcessViews\(\)\}<\/>\}/);
  // 计数、耗时和 ref 下标仍要先算出来（摘要行要用），只是不再构造节点。
  assert.match(source, /bucketToolCount \+= countToolCallBlocks\(sliceBlocks\);/);
  assert.match(source, /bucketRefIdx \?\?= visibleRefIndexByMessage\.get\(processIdx\);/);
});
