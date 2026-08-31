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
    setModel: async (model) => { current = model; },
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
    setModel: async (model) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
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

test("runtime generation 变化后旧队列任务失效，由 reset 使用新快照恢复", async () => {
  const catalog = openAiModel();
  let current = catalog;
  let runtime = { generation: "runtime-1", catalogModel: () => catalog, fastModels: new Set() };
  let applied = 0;
  const setting = new FastSessionSetting({
    entries: () => [],
    currentModel: () => current,
    runtimeSnapshot: () => runtime,
    setModel: async (model) => { current = model; applied += 1; },
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
