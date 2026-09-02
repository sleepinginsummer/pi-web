import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildMessageRenderGroups, buildRecentItemWindow } = await createJiti(import.meta.url).import("./message-render-groups.ts");
const isAnchor = (message) => message.role === "user" || message.role === "compaction";
const findFinal = (messages, start, end) => {
  for (let index = end - 1; index > start; index--) if (messages[index].role === "assistant") return index;
  return -1;
};

test("线性消息按 user turn 生成轻量分组", () => {
  const messages = [
    { role: "user" }, { role: "assistant" }, { role: "tool" },
    { role: "user" }, { role: "assistant" },
  ];
  const result = buildMessageRenderGroups(messages, {
    isAnchor, findFinalAssistantIndex: findFinal, busy: false, lastAnchorIndex: 3,
  });
  assert.deepEqual(result.groups, [
    { start: 0, end: 3, finalAssistantIdx: 1, isLiveTail: false },
    { start: 3, end: 5, finalAssistantIdx: 4, isLiveTail: false },
  ]);
  assert.equal(result.liveTailStartIndex, null);
});

test("compaction 可作为新轮次锚点", () => {
  const messages = [{ role: "user" }, { role: "assistant" }, { role: "compaction" }, { role: "assistant" }];
  const result = buildMessageRenderGroups(messages, {
    isAnchor, findFinalAssistantIndex: findFinal, busy: false, lastAnchorIndex: 2,
  });
  assert.deepEqual(result.groups.map(({ start, end }) => [start, end]), [[0, 2], [2, 4]]);
});

test("运行中尾轮记录 live-tail group 起点", () => {
  const messages = [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "tool" }];
  const result = buildMessageRenderGroups(messages, {
    isAnchor, findFinalAssistantIndex: findFinal, busy: true, lastAnchorIndex: 2,
  });
  assert.equal(result.liveTailStartIndex, 1);
  assert.equal(result.groups[1].isLiveTail, true);
});

test("运行中处理窗口跨消息只保留末尾三项", () => {
  assert.deepEqual(buildRecentItemWindow([2, 1, 4], 3), {
    hiddenCount: 4,
    visibleOffsets: [2, 1, 1],
  });
});

test("处理项不足上限时全部可见", () => {
  assert.deepEqual(buildRecentItemWindow([1, 0, 2], 3), {
    hiddenCount: 0,
    visibleOffsets: [0, 0, 0],
  });
});
