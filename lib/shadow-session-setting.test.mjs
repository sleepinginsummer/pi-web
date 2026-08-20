import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ShadowSessionSetting,
  restoreShadowSessionSettingSafely,
} = await jiti.import("./shadow-session-setting.ts");
const {
  SHADOW_MIND_SESSION_STATE,
  parseShadowMindToggleCommand,
  readSessionShadowMindEnabled,
} = await jiti.import("./shadow-session-protocol.ts");

function stateEntry(id, enabled) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: SHADOW_MIND_SESSION_STATE,
    data: { enabled },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHost({ entries = [], handler, appendState } = {}) {
  const calls = [];
  const persisted = [];
  const command = {
    name: "shadow",
    sourceInfo: { path: "/pkg/pi-shadow-mind/dist/index.js", source: "pi-shadow-mind" },
    async handler(action) {
      calls.push(action);
      await handler?.(action);
    },
  };
  return {
    calls,
    persisted,
    host: {
      entries: () => entries,
      appendState: (enabled) => appendState ? appendState(enabled) : persisted.push(enabled),
      commands: () => [command],
      createCommandContext: () => ({}),
    },
  };
}

test("读取会话中最后一个有效 Shadow 开关状态", () => {
  const entries = [stateEntry("off", false), stateEntry("on", true)];
  assert.equal(readSessionShadowMindEnabled(entries), true);
  assert.equal(readSessionShadowMindEnabled([]), true);
});

test("Web slash pause/resume 映射到同一会话设置入口", () => {
  assert.equal(parseShadowMindToggleCommand("/shadow pause"), false);
  assert.equal(parseShadowMindToggleCommand(" /shadow RESUME "), true);
  assert.equal(parseShadowMindToggleCommand("/shadow status"), null);
});

test("禁用状态在 runtime 重建后重新执行 pause", async () => {
  const { host, calls } = createHost({ entries: [stateEntry("off", false)] });
  const setting = new ShadowSessionSetting(host);

  await setting.restoreAfterRuntimeReset();
  await setting.restoreAfterRuntimeReset();

  assert.deepEqual(calls, ["pause", "pause"]);
  assert.equal(setting.current, false);
});

test("插件缺失时恢复降级通过，显式切换才报错", async () => {
  const host = {
    entries: () => [stateEntry("off", false)],
    appendState: () => assert.fail("不应写入"),
    commands: () => [],
    createCommandContext: () => ({}),
  };
  const setting = new ShadowSessionSetting(host);

  await setting.restoreAfterRuntimeReset();
  assert.equal(setting.available, false);
  assert.equal(setting.current, false);
  await assert.rejects(() => setting.setEnabled(true), /未加载 Shadow Mind/);
});

test("交错 pause→resume 采用最后一次目标并串行执行", async () => {
  const pause = deferred();
  const { host, calls, persisted } = createHost({
    handler: (action) => action === "pause" ? pause.promise : undefined,
  });
  const setting = new ShadowSessionSetting(host);

  const disabling = setting.setEnabled(false);
  while (calls.length === 0) await Promise.resolve();
  const enabling = setting.setEnabled(true);
  pause.resolve();

  assert.equal(await disabling, true);
  assert.equal(await enabling, true);
  assert.deepEqual(calls, ["pause", "resume"]);
  assert.deepEqual(persisted, [true]);
});

test("pause 未完成时的 runtime reset 在同一队列中重新 reconcile", async () => {
  const pause = deferred();
  let pauseCalls = 0;
  const { host, calls } = createHost({
    handler: (action) => {
      if (action === "pause" && ++pauseCalls === 1) return pause.promise;
      return undefined;
    },
  });
  const setting = new ShadowSessionSetting(host);

  const disabling = setting.setEnabled(false);
  await Promise.resolve();
  const restoring = setting.restoreAfterRuntimeReset();
  pause.resolve();
  await disabling;
  await restoring;

  assert.deepEqual(calls, ["pause", "pause"]);
  assert.equal(setting.current, false);
});

test("后台恢复失败降级返回并保留实际开启状态", async () => {
  const failure = new Error("restore pause failed");
  const { host } = createHost({
    entries: [stateEntry("off", false)],
    handler: () => Promise.reject(failure),
  });
  const setting = new ShadowSessionSetting(host);

  assert.deepEqual(await restoreShadowSessionSettingSafely(setting), { ok: false, error: failure });
  assert.equal(setting.current, true);
});

test("状态 entry 写入失败时反向恢复 runtime", async () => {
  const failure = new Error("append failed");
  const { host, calls } = createHost({ appendState: () => { throw failure; } });
  const setting = new ShadowSessionSetting(host);

  await assert.rejects(() => setting.setEnabled(false), failure);
  assert.deepEqual(calls, ["pause", "resume"]);
  assert.equal(setting.current, true);
});

test("最新切换失败时回滚到已生效状态且不持久化", async () => {
  const failure = new Error("pause failed");
  const { host, persisted } = createHost({ handler: () => Promise.reject(failure) });
  const setting = new ShadowSessionSetting(host);

  await assert.rejects(() => setting.setEnabled(false), failure);
  assert.equal(setting.current, true);
  assert.deepEqual(persisted, []);
});
