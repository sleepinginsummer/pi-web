import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { wakeMessageTitle } = await jiti.import("./wake-message-title.ts");
const { BACKGROUND_COMMAND_MESSAGE_TYPE, SCHEDULED_TASK_MESSAGE_TYPE } = await jiti.import("./wake-message-types.ts");

test("后台命令用 label 当标题，没有 label 退回命令行", () => {
  const labeled = 'Background command [ac2a309f] "Advisory 抓 producer" exited with code 0 after 3s\n$ cd /tmp && run.sh\n(no output)';
  assert.equal(wakeMessageTitle(BACKGROUND_COMMAND_MESSAGE_TYPE, labeled), "Advisory 抓 producer");

  const unlabeled = "Background command [7fa11a76] running for 30m00s\n$ sleep 2450 && enq-sample\n(output…)";
  assert.equal(wakeMessageTitle(BACKGROUND_COMMAND_MESSAGE_TYPE, unlabeled), "sleep 2450 && enq-sample");

  assert.equal(wakeMessageTitle(BACKGROUND_COMMAND_MESSAGE_TYPE, "完全不是唤醒消息"), null);
});

test("定时任务用任务名当标题", () => {
  const text = '⏰ Scheduled task "每天 9 点的行情抓取" [t-1] fired (每天 09:00). It will fire again on schedule.\n\n请抓取今天的行情并汇总。';
  assert.equal(wakeMessageTitle(SCHEDULED_TASK_MESSAGE_TYPE, text), "每天 9 点的行情抓取");
});

test("其它自定义消息不套用标题", () => {
  assert.equal(wakeMessageTitle("pi-shadow-mind", 'Background command [x] "a" exited'), null);
  assert.equal(wakeMessageTitle(undefined, "随便"), null);
  assert.equal(wakeMessageTitle(BACKGROUND_COMMAND_MESSAGE_TYPE, ""), null);
});
