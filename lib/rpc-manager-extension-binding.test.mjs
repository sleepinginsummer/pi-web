import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 绑定等待上限必须在导入模块前设定：常量在模块加载时解析。
process.env.PI_WEB_EXTENSION_BINDING_TIMEOUT_MS = "150";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, resolveExtensionBindingWaitTimeoutMs } = await jiti.import("./rpc-manager.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const MODELS = [
  { provider: "test", id: "model-a", api: "openai-completions" },
  { provider: "test", id: "model-b", api: "openai-completions" },
];

function createWrapper(t, bindExtensions) {
  const inner = {
    sessionId: "extension-binding-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    model: MODELS[0],
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] }, abort() {} },
    modelRuntime: { getModel: (provider, id) => MODELS.find((model) => model.provider === provider && model.id === id) },
    getContextUsage: () => null,
    abortBranchSummary() {}, abortCompaction() {}, abortRetry() {}, dispose() {},
    extensionRunner: { getRegisteredCommands: () => [] },
    bindExtensions,
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, inner };
}

test("get_state 不再等扩展绑定，完成时发出 extensions_bound", async (t) => {
  let releaseBinding;
  const { wrapper, events } = createWrapper(t, () => new Promise((resolve) => { releaseBinding = resolve; }));

  wrapper.beginExtensionBinding();
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.extensionsInitializing, true);
  assert.equal(state.extensionsError, null);
  assert.equal(wrapper.extensionsInitializing, true);

  releaseBinding();
  await nextTurn();
  assert.equal(wrapper.extensionsInitializing, false);
  assert.ok(events.some((event) => event.type === "extensions_bound"), "绑定完成后必须通知前端解锁");
  assert.equal((await wrapper.send({ type: "get_state" })).extensionsInitializing, false);
});

test("绑定未完成时 prompt 等待，超过上限后给出可读错误且不误报失败", async (t) => {
  const { wrapper, events } = createWrapper(t, () => new Promise(() => {}));

  wrapper.beginExtensionBinding();
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hi" }),
    /扩展初始化超过 \d+s 仍未完成/,
  );
  // 超时只结束这一次等待：绑定仍在后台，状态仍如实标注初始化中。
  assert.equal(wrapper.extensionsInitializing, true);
  assert.equal(events.some((event) => event.type === "extensions_error"), false);
});

test("绑定失败时发出 extensions_error 并暴露错误文本", async (t) => {
  const { wrapper, events } = createWrapper(t, () => { throw new Error("extension failed to start"); });

  wrapper.beginExtensionBinding();
  await nextTurn();
  assert.equal(wrapper.extensionsInitializing, false);
  assert.equal(wrapper.extensionsError, "extension failed to start");
  assert.deepEqual(
    events.find((event) => event.type === "extensions_error"),
    { type: "extensions_error", errorMessage: "extension failed to start" },
  );
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.extensionsError, "extension failed to start");
});

test("绑定等待上限按环境变量解析，0 表示不限时", () => {
  // 默认值取自环境变量，这里先清掉本文件为超时用例设置的值。
  delete process.env.PI_WEB_EXTENSION_BINDING_TIMEOUT_MS;
  assert.equal(resolveExtensionBindingWaitTimeoutMs(undefined), 20_000);
  process.env.PI_WEB_EXTENSION_BINDING_TIMEOUT_MS = "150";
  assert.equal(resolveExtensionBindingWaitTimeoutMs(""), 20_000);
  assert.equal(resolveExtensionBindingWaitTimeoutMs("5000"), 5_000);
  assert.equal(resolveExtensionBindingWaitTimeoutMs("0"), 0);
  assert.equal(resolveExtensionBindingWaitTimeoutMs("abc"), 20_000);
  assert.equal(resolveExtensionBindingWaitTimeoutMs("-1"), 20_000);
});
