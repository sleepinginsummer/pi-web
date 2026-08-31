import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearActiveFloatingSessionNotification,
  dismissFloatingSessionNotification,
  shouldQueueSessionNotification,
  upsertFloatingSessionNotification,
} = await jiti.import("./floating-session-notifications.ts");

function notification(sessionId, title = sessionId) {
  return { sessionId, title, body: `${title} body`, url: `/?session=${sessionId}` };
}

test("不同会话堆叠，同一会话更新后移到队首", () => {
  const previous = [notification("session-2"), notification("session-1", "old")];
  const next = upsertFloatingSessionNotification(previous, notification("session-1", "new"));

  assert.deepEqual(next.map((item) => [item.sessionId, item.title]), [
    ["session-1", "new"],
    ["session-2", "session-2"],
  ]);
});

test("关闭会话通知且不存在时保持原引用", () => {
  const previous = [notification("session-1"), notification("session-2")];
  assert.deepEqual(
    dismissFloatingSessionNotification(previous, "session-1").map((item) => item.sessionId),
    ["session-2"],
  );
  assert.equal(dismissFloatingSessionNotification(previous, "missing"), previous);
});

test("进入会话后清除对应通知", () => {
  const previous = [notification("session-1"), notification("session-2")];
  assert.deepEqual(
    clearActiveFloatingSessionNotification(previous, "session-2").map((item) => item.sessionId),
    ["session-1"],
  );
  assert.equal(clearActiveFloatingSessionNotification(previous, null), previous);
});

test("当前会话仅在显式允许时进入悬浮队列", () => {
  assert.equal(shouldQueueSessionNotification("session-1", "session-1"), false);
  assert.equal(shouldQueueSessionNotification("session-1", "session-1", true), true);
  assert.equal(shouldQueueSessionNotification("session-1", null, true), false);
  assert.equal(shouldQueueSessionNotification("session-1", "session-2"), true);
});
