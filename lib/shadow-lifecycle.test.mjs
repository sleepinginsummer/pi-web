import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ShadowLifecycleCoordinator } = await jiti.import("./shadow-lifecycle.ts");

function entry(id, kind, runId) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "shadow-mind-event",
    data: { kind, data: runId ? { runId } : {} },
  };
}

test("只消费会改变可见生命周期的 Shadow entry", () => {
  const coordinator = new ShadowLifecycleCoordinator();

  assert.deepEqual(coordinator.consume(undefined), { changed: false, hasActiveRuns: false });
  assert.deepEqual(coordinator.consume(entry("heartbeat", "heartbeat")), { changed: false, hasActiveRuns: false });
  assert.deepEqual(coordinator.consume(entry("start", "run-start", "run-1")), { changed: true, hasActiveRuns: true });
  assert.deepEqual(coordinator.consume(entry("end", "run-end", "run-1")), { changed: true, hasActiveRuns: false });
});

test("重复 entry 和乱序 start 不会复活已结束任务", () => {
  const coordinator = new ShadowLifecycleCoordinator();
  const start = entry("start", "run-start", "run-1");

  assert.deepEqual(coordinator.consume(start), { changed: true, hasActiveRuns: true });
  assert.deepEqual(coordinator.consume(start), { changed: false, hasActiveRuns: true });
  assert.deepEqual(coordinator.consume(entry("end", "run-end", "run-1")), { changed: true, hasActiveRuns: false });
  assert.deepEqual(coordinator.consume(entry("late-start", "run-start", "run-1")), { changed: true, hasActiveRuns: false });
});

test("runs-aborted 清空活动任务且 reset 允许新会话复用 run id", () => {
  const coordinator = new ShadowLifecycleCoordinator();

  coordinator.consume(entry("start-1", "run-start", "run-1"));
  coordinator.consume(entry("start-2", "run-start", "run-2"));
  assert.deepEqual(coordinator.consume(entry("abort", "runs-aborted")), { changed: true, hasActiveRuns: false });

  coordinator.reset();
  assert.deepEqual(coordinator.consume(entry("new-start", "run-start", "run-1")), { changed: true, hasActiveRuns: true });
});
