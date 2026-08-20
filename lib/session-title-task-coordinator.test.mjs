import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("./session-title-task-coordinator.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { SessionTitleTaskCoordinator } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const states = new Map([
    ["/active.jsonl", { sessionId: "session-1", name: "旧标题" }],
    ["/trash.jsonl", { sessionId: "session-1", name: "旧标题" }],
  ]);
  const runs = [];
  const coordinator = new SessionTitleTaskCoordinator({
    normalizePath: (filePath) => filePath,
    readState: (filePath) => states.get(filePath) ?? null,
    run: (request) => {
      const pending = deferred();
      runs.push({ request, pending });
      return pending.promise;
    },
  });
  return { coordinator, runs, states };
}

test("普通标题任务按 sessionId 共享同一个 Promise", () => {
  const { coordinator, runs } = createHarness();
  const first = coordinator.submit("/active.jsonl");
  const second = coordinator.submit("/trash.jsonl");

  assert.equal(first, second);
  assert.equal(runs.length, 1);
});

test("overwrite 在普通任务后串行执行且多个请求共享排队任务", async () => {
  const { coordinator, runs, states } = createHarness();
  const first = coordinator.submit("/active.jsonl");
  const overwrite = coordinator.submit("/active.jsonl", true);
  const duplicate = coordinator.submit("/active.jsonl", true);

  assert.equal(overwrite, duplicate);
  assert.equal(runs.length, 1);
  states.set("/active.jsonl", { sessionId: "session-1", name: "自动标题" });
  runs[0].pending.resolve("自动标题");
  await first;
  await Promise.resolve();
  assert.equal(runs.length, 2);
  runs[1].pending.resolve("手动生成标题");
  assert.equal(await overwrite, "手动生成标题");
});

test("rename 迁移正在执行及排队任务的共享目标路径", async () => {
  const { coordinator, runs, states } = createHarness();
  const first = coordinator.submit("/active.jsonl");
  const overwrite = coordinator.submit("/active.jsonl", true);
  coordinator.migrate("session-1", "/trash.jsonl");

  assert.equal(runs[0].request.target.filePath, "/trash.jsonl");
  states.set("/trash.jsonl", { sessionId: "session-1", name: "自动标题" });
  runs[0].pending.resolve("自动标题");
  await first;
  await Promise.resolve();
  assert.equal(runs[1].request.target.filePath, "/trash.jsonl");
  runs[1].pending.resolve("手动生成标题");
  await overwrite;
});

test("overwrite 排队期间用户改名会取消覆盖", async () => {
  const { coordinator, runs, states } = createHarness();
  coordinator.submit("/active.jsonl");
  const overwrite = coordinator.submit("/active.jsonl", true);

  states.set("/active.jsonl", { sessionId: "session-1", name: "用户新标题" });
  runs[0].pending.resolve(null);
  assert.equal(await overwrite, null);
  assert.equal(runs.length, 1);
});

test("用户改名后的新 overwrite 会追加 successor，不共享旧基线任务", async () => {
  const { coordinator, runs, states } = createHarness();
  coordinator.submit("/active.jsonl");
  const staleOverwrite = coordinator.submit("/active.jsonl", true);

  states.set("/active.jsonl", { sessionId: "session-1", name: "用户新标题" });
  const latestOverwrite = coordinator.submit("/active.jsonl", true);
  assert.notEqual(latestOverwrite, staleOverwrite);

  runs[0].pending.resolve(null);
  assert.equal(await staleOverwrite, null);
  await Promise.resolve();
  assert.equal(runs.length, 2);
  runs[1].pending.resolve("最新生成标题");
  assert.equal(await latestOverwrite, "最新生成标题");
});

test("任务异常后清理 registry，后续请求可以重新执行", async () => {
  const { coordinator, runs } = createHarness();
  const failed = coordinator.submit("/active.jsonl");
  runs[0].pending.reject(new Error("provider failed"));
  await assert.rejects(failed, /provider failed/);

  coordinator.submit("/active.jsonl");
  assert.equal(runs.length, 2);
  runs[1].pending.resolve(null);
});

test("HMR 后共享 registry 的 successor 使用新 runner 且不被旧 finally 清理", async () => {
  const registry = new Map();
  const states = new Map([["/active.jsonl", { sessionId: "session-1", name: "旧标题" }]]);
  const oldRun = deferred();
  const newRuns = [];
  const oldCoordinator = new SessionTitleTaskCoordinator({
    normalizePath: (filePath) => filePath,
    readState: (filePath) => states.get(filePath) ?? null,
    run: () => oldRun.promise,
  }, registry);
  const first = oldCoordinator.submit("/active.jsonl");

  // 模拟模块热更新：当前 class/dependencies 新建 coordinator，但沿用全局纯 Map。
  const newCoordinator = new SessionTitleTaskCoordinator({
    normalizePath: (filePath) => filePath,
    readState: (filePath) => states.get(filePath) ?? null,
    run: (request) => {
      const pending = deferred();
      newRuns.push({ request, pending });
      return pending.promise;
    },
  }, registry);
  const successor = newCoordinator.submit("/active.jsonl", true);
  assert.equal(newRuns.length, 0);

  states.set("/active.jsonl", { sessionId: "session-1", name: "自动标题" });
  oldRun.resolve("自动标题");
  await first;
  await Promise.resolve();
  assert.equal(newRuns.length, 1);

  // A 的旧 finally 不能删掉已经替换进共享 Map 的 B。
  assert.equal(registry.get("session-1")?.promise, successor);
  newRuns[0].pending.resolve("新实现标题");
  assert.equal(await successor, "新实现标题");
});
