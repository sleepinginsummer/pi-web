import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  beginDraftModelSwitch,
  getDraftModelSwitch,
  isLatestDraftModelSwitch,
  registerDraftModelSwitch,
  settleDraftModelSwitch,
  waitForDraftModelSwitchTask,
} = await jiti.import("./draft-model-switch.ts");

test("草稿切模任务按 cwd 共享，重建的实例也能等到它", async () => {
  const selection = {
    model: { provider: "test", modelId: "model-b" },
    thinkingLevel: "low",
    thinkingLevelSource: "auto",
  };
  let resolve;
  const task = new Promise((done) => { resolve = done; });

  assert.equal(getDraftModelSwitch("/work/a"), null);
  const version = beginDraftModelSwitch("/work/a");
  registerDraftModelSwitch("/work/a", version, task);
  assert.deepEqual(getDraftModelSwitch("/work/a"), { version, task });
  // 别的 cwd 互不影响：两个项目的草稿各等各的。
  assert.equal(getDraftModelSwitch("/work/b"), null);

  resolve(selection);
  assert.deepEqual(await getDraftModelSwitch("/work/a").task, selection);

  settleDraftModelSwitch("/work/a", version);
  assert.equal(getDraftModelSwitch("/work/a"), null);
});

test("同草稿上后起的切模会让先发起的那次过期", () => {
  const first = beginDraftModelSwitch("/work/c");
  const firstTask = Promise.resolve(null);
  registerDraftModelSwitch("/work/c", first, firstTask);
  assert.equal(isLatestDraftModelSwitch("/work/c", first), true);

  // 重建出来的实例又选了一个模型：版本前进，先发起的那次作废。
  const second = beginDraftModelSwitch("/work/c");
  assert.ok(second > first);
  assert.equal(isLatestDraftModelSwitch("/work/c", first), false);
  assert.equal(isLatestDraftModelSwitch("/work/c", second), true);
  // 过期的那次不能登记自己的任务，也不能清掉新的那一轮。
  const staleTask = Promise.resolve(null);
  registerDraftModelSwitch("/work/c", first, staleTask);
  assert.equal(getDraftModelSwitch("/work/c"), null);
  settleDraftModelSwitch("/work/c", first);
  assert.equal(isLatestDraftModelSwitch("/work/c", second), true);

  const secondTask = Promise.resolve(null);
  registerDraftModelSwitch("/work/c", second, secondTask);
  assert.deepEqual(getDraftModelSwitch("/work/c"), { version: second, task: secondTask });
  settleDraftModelSwitch("/work/c", second);
  assert.equal(getDraftModelSwitch("/work/c"), null);
  // 版本留着：晚到的提交仍能认出自己已经过期。
  assert.equal(isLatestDraftModelSwitch("/work/c", first), false);
  assert.equal(isLatestDraftModelSwitch("/work/c", second), true);
});
