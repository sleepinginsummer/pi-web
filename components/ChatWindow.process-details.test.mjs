import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
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

test("无最终答复的结束轮次默认展开处理过程", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/);
  assert.match(source, /key=\{finalAnswerMessage \? "answered" : "unanswered"\}/);
});

test("运行中的处理过程只挂载最近三项并可按需展开", () => {
  assert.match(source, /const LIVE_PROCESS_ITEM_LIMIT = 3/);
  assert.match(source, /buildRecentItemWindow\([\s\S]*?LIVE_PROCESS_ITEM_LIMIT/);
  assert.match(source, /expanded \? renderAll\(\) : renderRecent\(\)/);
  assert.match(source, /visibleBlockOffset=\{options\.visibleBlockOffset\}/);
});
