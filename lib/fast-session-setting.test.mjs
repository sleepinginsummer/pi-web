import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { FastSessionSetting } = await createJiti(import.meta.url).import("./fast-session-setting.ts");

function openAiModel(overrides = {}) {
  return {
    id: "gpt-test",
    provider: "openai",
    api: "openai-responses",
    compat: { supportsReasoningEffort: true },
    samplingParams: { temperature: 0.2 },
    ...overrides,
  };
}

test("关闭 Fast 时从 catalog 恢复原始 service_tier", async () => {
  const catalog = openAiModel({ samplingParams: { service_tier: "default", temperature: 0.1 } });
  let current = catalog;
  const entries = [];
  const setting = new FastSessionSetting({
    entries: () => entries,
    currentModel: () => current,
    runtimeSnapshot: () => ({ generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() }),
    setModel: async (model, beforeWrite) => { beforeWrite(); current = model; },
    appendState: (enabled) => entries.push({ type: "custom", customType: "pi-web-fast-mode-state", data: { enabled } }),
  });

  await setting.setEnabled(true);
  assert.equal(current.samplingParams.service_tier, "priority");
  await setting.setEnabled(false);
  assert.equal(current.samplingParams.service_tier, "default");
  assert.deepEqual(entries.map((entry) => entry.data.enabled), [true, false]);
});

test("快速切换按队列应用最后偏好且每次重取 catalog", async () => {
  let catalog = openAiModel({ samplingParams: { marker: 1 } });
  let current = catalog;
  const persisted = [];
  const applied = [];
  const setting = new FastSessionSetting({
    entries: () => [],
    currentModel: () => current,
    runtimeSnapshot: () => ({ generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() }),
    setModel: async (model, beforeWrite) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      beforeWrite();
      current = model;
      applied.push(model.samplingParams);
    },
    appendState: (enabled) => persisted.push(enabled),
  });

  const enabling = setting.setEnabled(true);
  catalog = openAiModel({ samplingParams: { marker: 2 } });
  const disabling = setting.setEnabled(false);
  await Promise.all([enabling, disabling]);

  assert.equal(current.samplingParams.marker, 2);
  assert.equal(current.samplingParams.service_tier, undefined);
  assert.equal(persisted.at(-1), false);
  assert.equal(setting.current, false);
  assert.ok(applied.every((params) => params.marker === 2));
});

test("模型应用后状态写入被拒绝时，不把失败的 Fast 偏好标成已应用", async () => {
  const catalog = openAiModel();
  let current = catalog;
  let thinkingLevel = "high";
  const setting = new FastSessionSetting({
    entries: () => [], currentModel: () => current,
    runtimeSnapshot: () => ({ generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() }),
    captureRuntime: () => {
      const savedModel = current;
      const savedLevel = thinkingLevel;
      return () => { current = savedModel; thinkingLevel = savedLevel; };
    },
    setModel: async (model, beforeWrite) => { beforeWrite(); current = model; thinkingLevel = "low"; },
    appendState: () => { throw new Error("external write"); },
  });
  await assert.rejects(setting.setEnabled(true), /external write/);
  assert.equal(setting.current, false);
  assert.strictEqual(current, catalog);
  assert.equal(thinkingLevel, "high");
});

test("runtime generation 变化后旧队列任务失效，由 reset 使用新快照恢复", async () => {
  const catalog = openAiModel();
  let current = catalog;
  let runtime = { generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() };
  let applied = 0;
  const setting = new FastSessionSetting({
    entries: () => [],
    currentModel: () => current,
    runtimeSnapshot: () => runtime,
    setModel: async (model, beforeWrite) => { beforeWrite(); current = model; applied += 1; },
    appendState: () => {},
  });

  const enabling = setting.setEnabled(true);
  runtime = { ...runtime, generation: "runtime-2" };
  await enabling;
  assert.equal(applied, 0);

  await setting.restoreAfterRuntimeReset();
  assert.equal(applied, 1);
  assert.equal(current.samplingParams.service_tier, "priority");
});

for (const sameId of [true, false]) test(`generation 失效时显式选模拒绝且允许重试：sameId=${sameId}`, async () => {
  const original = openAiModel({ contextWindow: 32000 });
  const target = openAiModel({ id: sameId ? original.id : "other", contextWindow: 64000 });
  let current = original;
  let runtime = { generation: "runtime-1", catalogModel: () => target, fastModels: new Set() };
  let applied = 0;
  const setting = new FastSessionSetting({
    entries: () => [], currentModel: () => current, runtimeSnapshot: () => runtime,
    setModel: async (model, beforeWrite) => { beforeWrite(); current = model; applied += 1; },
    appendState: () => { assert.fail("失效或重试的选模不得改写 Fast 偏好"); },
  });
  const selection = setting.selectModel(target, sameId ? { expectedModel: original } : undefined);
  runtime = { ...runtime, generation: "runtime-2" };
  await assert.rejects(selection, /模型配置已重载.*重试/);
  assert.strictEqual(current, original);
  assert.equal(applied, 0);
  await setting.selectModel(target, sameId ? { expectedModel: original } : undefined);
  assert.equal(current.contextWindow, 64000);
  assert.equal(current.id, target.id);
  assert.equal(applied, 1);
});

for (const outcome of ["success", "auth-error", "state-error"]) test(`同模型 Fast 先鉴权、落盘再改内存：${outcome}`, async () => {
  const catalog = openAiModel({ samplingParams: { service_tier: "default" } });
  let current = catalog;
  const entries = [];
  const events = [];
  const setting = new FastSessionSetting({
    entries: () => entries,
    currentModel: () => current,
    runtimeSnapshot: () => ({ generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() }),
    captureRuntime: () => { assert.fail("尚未修改内存的同模型路径不应捕获或恢复 SDK 状态"); },
    setModel: async () => { assert.fail("同身份副本不应执行重新选模"); },
    prepareSameModel: async (model) => {
      events.push("auth");
      if (outcome === "auth-error") throw new Error("模拟鉴权异常");
      return {
        validate: () => { events.push("validate"); },
        commit: () => { events.push("commit"); current = model; },
      };
    },
    appendState: enabled => {
      assert.equal(current.samplingParams.service_tier, enabled ? "default" : "priority", "状态落盘时仍使用上一次生效的模型");
      events.push("state");
      if (outcome === "state-error") throw new Error("模拟持久化异常");
      entries.push({ type: "custom", customType: "pi-web-fast-mode-state", data: { enabled } });
    },
  });
  if (outcome !== "success") {
    await assert.rejects(setting.setEnabled(true), /模拟/);
    assert.strictEqual(current, catalog);
    assert.equal(setting.current, false);
    assert.equal(entries.length, 0);
    assert.ok(!events.includes("commit"));
    return;
  }
  await setting.setEnabled(true);
  assert.equal(current.samplingParams.service_tier, "priority");
  assert.notStrictEqual(current, catalog);
  await setting.setEnabled(false);
  assert.equal(current.samplingParams.service_tier, "default");
  assert.equal(catalog.samplingParams.service_tier, "default", "不得修改目录模型");
  assert.deepEqual(events, ["auth", "validate", "state", "commit", "auth", "validate", "state", "commit"]);
});

for (const operation of ["toggle", "reselect"]) test(`最终校验拒绝 ${operation} 后，Fast 只跟随当前模型且不写入失败偏好`, async () => {
  const a = openAiModel();
  const b = openAiModel({ id: "b", provider: "synthetic", api: "anthropic-messages" });
  let current = a;
  let switchOnce = true;
  const entries = [];
  const conflict = new Error("模型引用已变化");
  const setting = new FastSessionSetting({
    entries: () => entries,
    currentModel: () => current,
    runtimeSnapshot: () => ({ generation: "runtime-1", fastModels: new Set(),
      catalogModel: (provider, id) => [a, b].find(model => model.provider === provider && model.id === id) }),
    captureRuntime: () => { assert.fail("最终校验失败前不得捕获回滚快照"); },
    setModel: async () => { assert.fail("Fast 不得切回失败的显式目标"); },
    prepareSameModel: async model => {
      const expected = current;
      if (switchOnce) {
        switchOnce = false;
        // 模拟准备阶段首次校验已通过，但 await 的调用方尚未恢复时扩展切模。
        queueMicrotask(() => { current = b; });
      }
      return {
        validate: () => { if (current !== expected) throw conflict; },
        commit: () => { current = model; },
      };
    },
    appendState: enabled => entries.push({ type: "custom", customType: "pi-web-fast-mode-state", data: { enabled } }),
  });
  await assert.rejects(operation === "toggle" ? setting.setEnabled(true) : setting.selectModel(a), error => error === conflict);
  assert.strictEqual(current, b);
  assert.equal(setting.current, false);
  assert.equal(setting.available, false, "可用性必须读取 B，而不是失败的 A");
  assert.equal(entries.length, 0, "最终校验必须早于状态落盘");
  await setting.setEnabled(false);
  assert.equal(current.id, b.id);
  assert.equal(current.provider, b.provider);
  assert.equal(setting.available, false);
  assert.deepEqual(entries.map(entry => entry.data.enabled), [false]);
});
