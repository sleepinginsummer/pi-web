import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SessionContextRefreshScheduler } = await jiti.import("./session-context-refresh-scheduler.ts");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("合并同一批次的会话上下文刷新", async () => {
  const scheduler = new SessionContextRefreshScheduler();
  let calls = 0;

  scheduler.schedule("session-a", () => { calls += 1; });
  scheduler.schedule("session-a", () => { calls += 1; });
  scheduler.schedule("session-a", () => { calls += 1; });
  await flushMicrotasks();

  assert.equal(calls, 1);
});

test("执行期间收到新事件时仅补跑一次", async () => {
  const scheduler = new SessionContextRefreshScheduler();
  const first = deferred();
  let calls = 0;

  scheduler.schedule("session-a", async () => {
    calls += 1;
    if (calls === 1) await first.promise;
  });
  await flushMicrotasks();
  scheduler.schedule("session-a", () => { calls += 1; });
  scheduler.schedule("session-a", () => { calls += 1; });
  first.resolve();
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(calls, 2);
});

test("取消会话后丢弃已排队刷新和执行后的补跑", async () => {
  const scheduler = new SessionContextRefreshScheduler();
  const running = deferred();
  let queuedCalls = 0;
  let runningCalls = 0;

  scheduler.schedule("queued", () => { queuedCalls += 1; });
  scheduler.cancel("queued");

  scheduler.schedule("running", async () => {
    runningCalls += 1;
    await running.promise;
  });
  await flushMicrotasks();
  scheduler.schedule("running", () => { runningCalls += 1; });
  scheduler.cancel("running");
  running.resolve();
  await flushMicrotasks();

  assert.equal(queuedCalls, 0);
  assert.equal(runningCalls, 1);
});
