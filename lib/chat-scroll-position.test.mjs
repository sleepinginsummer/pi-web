import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import ts from "typescript";

async function loadSubject() {
  const source = await fs.readFile(new URL("./chat-scroll-position.ts", import.meta.url), "utf8");
  const js = ts.transpile(source, {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  });
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("calculates bottom position and distance within scroll bounds", async () => {
  const { getBottomScrollTop, getDistanceToBottom } = await loadSubject();
  assert.equal(getBottomScrollTop(1200, 500), 700);
  assert.equal(getBottomScrollTop(300, 500), 0);
  assert.equal(getDistanceToBottom(1200, 500, 620), 80);
  assert.equal(getDistanceToBottom(1200, 500, 800), 0);
});

test("user scroll intent wins over the near-bottom threshold", async () => {
  const { getChatScrollFollowDecision } = await loadSubject();
  assert.equal(getChatScrollFollowDecision({
    distanceToBottom: 12,
    bottomThreshold: 48,
    now: 1_000,
    userScrollIntentUntil: 1_200,
    userScrollDirection: "up",
    ignoreProgrammaticScrollUntil: 1_600,
  }), "pause");
});

test("downward user scroll can resume when it reaches the bottom threshold", async () => {
  const { getChatScrollFollowDecision } = await loadSubject();
  assert.equal(getChatScrollFollowDecision({
    distanceToBottom: 12,
    bottomThreshold: 48,
    now: 1_000,
    userScrollIntentUntil: 1_200,
    userScrollDirection: "down",
    ignoreProgrammaticScrollUntil: 0,
  }), "follow");
});

test("unknown user scroll direction resumes when already at the bottom threshold", async () => {
  const { getChatScrollFollowDecision } = await loadSubject();
  assert.equal(getChatScrollFollowDecision({
    distanceToBottom: 12,
    bottomThreshold: 48,
    now: 1_000,
    userScrollIntentUntil: 1_200,
    userScrollDirection: "unknown",
    ignoreProgrammaticScrollUntil: 0,
  }), "follow");
});

test("programmatic scroll events keep the current follow state", async () => {
  const { getChatScrollFollowDecision } = await loadSubject();
  assert.equal(getChatScrollFollowDecision({
    distanceToBottom: 0,
    bottomThreshold: 48,
    now: 1_000,
    userScrollIntentUntil: 0,
    userScrollDirection: "unknown",
    ignoreProgrammaticScrollUntil: 1_600,
  }), "keep");
});

test("anchors the most recent turn that started before the viewport", async () => {
  const { findChatScrollAnchor } = await loadSubject();
  assert.deepEqual(findChatScrollAnchor([
    { entryId: "current-turn", top: 20, bottom: 80 },
    { entryId: "next-turn", top: 420, bottom: 480 },
  ], 200), {
    anchorEntryId: "current-turn",
    anchorOffset: -180,
  });
});

test("falls back to the last message when the viewport is below all candidates", async () => {
  const { findChatScrollAnchor } = await loadSubject();
  assert.deepEqual(findChatScrollAnchor([
    { entryId: "first", top: 0, bottom: 100 },
    { entryId: "last", top: 100, bottom: 200 },
  ], 250), {
    anchorEntryId: "last",
    anchorOffset: -150,
  });
});

test("uses the first turn when the viewport starts above it", async () => {
  const { findChatScrollAnchor } = await loadSubject();
  assert.deepEqual(findChatScrollAnchor([
    { entryId: "first", top: 120, bottom: 180 },
    { entryId: "second", top: 240, bottom: 300 },
  ], 100), {
    anchorEntryId: "first",
    anchorOffset: 20,
  });
});

test("returns null when the conversation has no anchor candidates", async () => {
  const { findChatScrollAnchor } = await loadSubject();
  assert.equal(findChatScrollAnchor([], 100), null);
});

test("手动压缩定位时间线上最后一张可见卡片", async () => {
  const { getCompactionScrollPosition } = await loadSubject();
  assert.deepEqual(getCompactionScrollPosition([
    { role: "custom", customType: "compaction", display: true },
    { role: "user" },
    { role: "custom", customType: "compaction", display: true },
    { role: "assistant" },
  ], ["old-compaction", "kept-user", "new-compaction", "last-reply"]), { entryId: "new-compaction" });
});

test("没有可显示的压缩卡片时不把其它消息当成定位目标", async () => {
  const { getCompactionScrollPosition } = await loadSubject();
  assert.equal(getCompactionScrollPosition([
    { role: "custom", customType: "compaction", display: false },
    { role: "assistant" },
  ], ["hidden", "last-reply"]), null);
});

test("拆分消息记录最终回答片段，不把相同 entryId 的前一段当成恢复目标", async () => {
  const { findChatScrollAnchor, findChatScrollRestoreTarget } = await loadSubject();
  const candidates = [
    { entryId: "answer", part: "body-0", top: 0, bottom: 200 },
    { entryId: "answer", part: "message", top: 300, bottom: 1600 },
  ];
  const position = findChatScrollAnchor(candidates, 800);
  assert.deepEqual(position, { anchorEntryId: "answer", anchorOffset: -500, anchorPart: "message" });
  assert.equal(findChatScrollRestoreTarget(candidates, position), candidates[1]);
  assert.equal(findChatScrollRestoreTarget(candidates, { anchorEntryId: "answer" }), candidates[0], "兼容没有片段标识的旧位置");
  assert.equal(findChatScrollRestoreTarget(candidates, { anchorEntryId: "answer", anchorPart: "gone" }), candidates[0], "片段消失时退回同一消息");
  assert.equal(findChatScrollRestoreTarget(candidates, { anchorEntryId: "missing" }), undefined);
});
