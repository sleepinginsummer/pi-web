import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LatestContextLoader } = await jiti.import("./latest-context-loader.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("旧响应晚到时不会重新成为最新结果，且最终释放资源", async () => {
  const loader = new LatestContextLoader();
  const oldResponse = deferred();
  const newResponse = deferred();

  const committed = [];
  const oldRun = loader.run("session-a", () => oldResponse.promise, (value) => committed.push(value));
  const newRun = loader.run("session-a", () => newResponse.promise, (value) => committed.push(value));
  newResponse.resolve("new");
  assert.deepEqual(await newRun, { committed: true, value: 1 });

  oldResponse.resolve("old");
  assert.deepEqual(await oldRun, { committed: false });
  assert.deepEqual(committed, ["new"]);
  assert.equal(loader.activeCount, 0);
});

test("context 完成后挂起的 state 阶段会被新请求取消并释放", async () => {
  const loader = new LatestContextLoader();
  const context = deferred();
  let oldStateAborted = false;

  const oldRun = loader.run("session-a", async (signal) => {
    await context.promise;
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        oldStateAborted = true;
        reject(new DOMException("请求已取消", "AbortError"));
      }, { once: true });
    });
    return "old";
  }, (value) => value);
  context.resolve();
  await Promise.resolve();

  const newRun = loader.run("session-a", async () => "new", (value) => value);
  assert.deepEqual(await newRun, { committed: true, value: "new" });
  assert.deepEqual(await oldRun, { committed: false });
  assert.equal(oldStateAborted, true);
  assert.equal(loader.activeCount, 0);
});

test("取消旧会话不会影响当前会话", async () => {
  const loader = new LatestContextLoader();
  const current = deferred();
  const currentRun = loader.run("session-b", () => current.promise, (value) => value);

  loader.cancel("session-a");
  current.resolve("current");

  assert.deepEqual(await currentRun, { committed: true, value: "current" });
  assert.equal(loader.activeCount, 0);
});
