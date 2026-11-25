import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const processSource = await readFile(new URL("./ProcessDetailsGroup.tsx", import.meta.url), "utf8");
const { buildMessageRenderGroups } = await createJiti(import.meta.url).import("../lib/message-render-groups.ts");

test("历史页从轮次中途开始时仍将前缀处理消息分为一组", () => {
  const messages = [{ role: "assistant" }, { role: "toolResult" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }];
  const { groups } = buildMessageRenderGroups(messages, {
    isAnchor: (message) => message.role === "user",
    findFinalAssistantIndex: (items, start, end) => {
      for (let index = end - 1; index > start; index--) if (items[index].role === "assistant") return index;
      return -1;
    },
    busy: false, lastAnchorIndex: 3,
  });
  assert.deepEqual(groups.map(({ start, end, finalAssistantIdx }) => [start, end, finalAssistantIdx]), [[0, 3, 2], [3, 5, 4]]);
  assert.match(source, /const processStart = hasAnchor \? start \+ 1 : start/);
  assert.match(source, /if \(hasAnchor\) nodes\.push\(renderMessage\(start\)\)/);
});

test("过程详情一律默认折叠，只有列表末尾这一轮折叠时先亮出最新几条", () => {
  assert.match(processSource, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  // 折叠时给最新几条：运行中的组和列表末尾的无答复轮次共用同一套窗口规则。
  assert.match(processSource, /contentVisible \? \([\s\S]*?: renderRecent \? \(/);
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?renderRecent=\{showsRecentWhenFolded \? renderFoldPreview : undefined\}/);
  // 折叠预览只给最后一段过程详情，且这一轮必须是列表末尾、答复前没有露出的正文。
  assert.match(
    source,
    /const showsRecentWhenFolded = isLastProcessGroup\s+&& end === messages\.length\s+&& !hasExposedBodySegment\s+&& !collapsesProcessDetails\(finalAnswerMessage\);/,
  );
  // 不再按「有没有答复」决定整组展开（#906 的正文由折叠预览兜住）。
  assert.doesNotMatch(source, /defaultExpanded=\{!/);
});

test("运行中只预览最近三项过程内容并可按需展开", () => {
  assert.match(source, /const LIVE_PROCESS_ITEM_LIMIT = 3/);
  assert.match(source, /buildRecentItemWindow\([\s\S]*?LIVE_PROCESS_ITEM_LIMIT/);
  assert.match(source, /expanded \? renderAll\(\) : renderRecent\(\)/);
  assert.match(source, /hiddenProcessBlockCount=\{options\.hiddenProcessBlockCount\}/);
});


test("正文段落把一轮的过程详情切成多段，各自折叠、各自计数", () => {
  // 长对话里连着几十步工具调用会被中间几段正文分隔开：整轮做成一个折叠组会把正文埋掉，
  // 所以每段过程详情自带条数和耗时，并各自保留一条可点击的折叠竖条。
  assert.match(source, /const isBody = isAssistantBodyBlock\(blocks\[cursor\]\)/);
  assert.match(source, /const flushBucket = \(\) => \{/);
  assert.match(source, /kind: "body"/);
  assert.match(source, /messageCount=\{seg\.messageCount\}/);
  assert.match(source, /toolCallCount=\{seg\.toolCallCount\}/);
  assert.match(source, /durationMs=\{isLastProcessGroup \? turnDurationMs : undefined\}/);
  assert.match(processSource, /collapse-rail-btn/);
  // 折叠竖条在长内容里点一下就收起，并把已经滚出视口的组顶回来。
  assert.match(processSource, /scrollIntoView\(\{ block: "nearest" \}\)/);
});
