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

test("centers the latest message and clamps to the available range", async () => {
  const { getInitialScrollTop } = await loadSubject();
  assert.equal(getInitialScrollTop({
    containerHeight: 600,
    containerScrollTop: 400,
    containerTop: 100,
    messageHeight: 200,
    messageTop: 500,
    scrollHeight: 1600,
  }), 600);
  assert.equal(getInitialScrollTop({
    containerHeight: 600,
    containerScrollTop: 0,
    containerTop: 100,
    messageHeight: 100,
    messageTop: 150,
    scrollHeight: 700,
  }), 0);
  assert.equal(getInitialScrollTop({
    containerHeight: 600,
    containerScrollTop: 900,
    containerTop: 100,
    messageHeight: 400,
    messageTop: 500,
    scrollHeight: 1400,
  }), 800);
});
