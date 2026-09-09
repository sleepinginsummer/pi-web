import assert from "node:assert/strict";
import test from "node:test";
import {
  clearManualStopNotificationSuppression,
  consumeManualStopNotificationSuppression,
  isManualStopNotificationSuppressed,
  markManualStopNotificationSuppressed,
} from "./manual-stop-notification.ts";

test("手动停止标记只抑制一次完成通知", () => {
  markManualStopNotificationSuppressed("session-a");

  assert.equal(isManualStopNotificationSuppressed("session-a"), true);
  assert.equal(isManualStopNotificationSuppressed("session-a"), true);
  assert.equal(consumeManualStopNotificationSuppression("session-a"), true);
  assert.equal(isManualStopNotificationSuppressed("session-a"), false);
  assert.equal(consumeManualStopNotificationSuppression("session-a"), false);
});

test("停止失败或下一轮开始可以恢复完成通知", () => {
  markManualStopNotificationSuppressed("session-b");
  clearManualStopNotificationSuppression("session-b");

  assert.equal(consumeManualStopNotificationSuppression("session-b"), false);
});
