import assert from "node:assert/strict";
import test from "node:test";
import { RunCompletionController } from "./run-completion-controller.ts";

test("begin 后只允许当前 run settle 一次", () => {
  const controller = new RunCompletionController();

  assert.equal(controller.settleRun(1, "session-a"), null);
  controller.beginRun(1);
  assert.deepEqual(controller.settleRun(1, "session-a"), { runId: 1, sessionId: "session-a" });
  assert.equal(controller.settleRun(1, "session-a"), null);
});

test("恢复 busy run 被采用后可以在 idle 时完成", () => {
  const controller = new RunCompletionController();

  controller.beginRun(7);
  assert.deepEqual(controller.settleRun(7, "restored-session"), {
    runId: 7,
    sessionId: "restored-session",
  });
});

test("新 run 会拒绝旧 run 的迟到 settled", () => {
  const controller = new RunCompletionController();

  controller.beginRun(2);
  controller.beginRun(3);
  assert.equal(controller.settleRun(2, "session-a"), null);
  assert.deepEqual(controller.settleRun(3, "session-a"), { runId: 3, sessionId: "session-a" });
});
