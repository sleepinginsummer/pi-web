import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { FastSessionSetting } = await jiti.import("./fast-session-setting.ts");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-model-reselect-"));
  const cwd = join(dir, "project");
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // No real credentials, extensions, catalog fetches or model requests.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const config = { providers: { synthetic: {
    baseUrl: "https://synthetic.invalid", api: "anthropic-messages", apiKey: "synthetic-not-a-key",
    models: [{ id: "primary", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
  } } };
  const save = () => writeModelsConfig(config, join(dir, "models.json"));
  save();
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: false } }));
  const { session: wrapper } = await startRpcSession(`__new__${dir}`, "", cwd, {
    toolNames: [], initialModel: { provider: "synthetic", modelId: "primary" }, thinkingLevel: "high", thinkingLevelExplicit: false,
  });
  t.after(() => wrapper.shutdown());
  return { wrapper, config, save, settingsPath, settingsBefore: await readFile(settingsPath, "utf8") };
}

const modelEntries = (inner) => inner.sessionManager.getEntries().filter((entry) =>
  entry.type === "model_change" || entry.type === "thinking_level_change");

test("reselecting a model applies a saved same-id edit and keeps the thinking level", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  Object.assign(f.config.providers.synthetic.models[0], {
    api: "openai-responses", baseUrl: "https://synthetic.invalid/v1", contextWindow: 64000,
  });
  f.save();
  assert.equal(inner.model.api, "anthropic-messages", "Saving must not touch a live session");
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.equal(inner.model.api, "openai-responses");
  assert.equal(inner.model.baseUrl, "https://synthetic.invalid/v1");
  assert.equal(inner.model.contextWindow, 64000);
  assert.equal(inner.thinkingLevel, "high", "defaultThinkingLevel=low must not replace the session's level");
  assert.equal(await readFile(f.settingsPath, "utf8"), f.settingsBefore);

  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${url.hostname}${url.pathname}`);
    return new Response(JSON.stringify({ error: { message: "Offline interception", type: "fixture" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  });
  await inner.prompt("Synthetic request, intercepted locally.");
  assert.deepEqual(requests, ["synthetic.invalid/v1/responses"], "The SDK request uses the new route");

  // A model that no longer reasons clamps the kept level, as any model switch does.
  f.config.providers.synthetic.models[0].reasoning = false;
  f.save();
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.equal(inner.thinkingLevel, "off");
});

test("reselecting an unchanged model writes no model or thinking entries", async (t) => {
  const { wrapper } = await fixture(t);
  const selected = wrapper.inner.model;
  const setModel = t.mock.method(wrapper.inner, "setModel");
  const before = modelEntries(wrapper.inner);
  await wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.strictEqual(wrapper.inner.model, selected);
  assert.deepEqual(modelEntries(wrapper.inner), before);
  assert.equal(setModel.mock.callCount(), 0);
});

test("同模型重选在档位记录写入失败时恢复原模型和档位，且允许重试", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const previousModel = inner.model;
  const beforeEntries = modelEntries(inner);
  const beforeFile = await readFile(inner.sessionFile, "utf8");
  Object.assign(f.config.providers.synthetic.models[0], { reasoning: false, contextWindow: 64000 });
  f.save();
  const writeError = Object.assign(new Error("模拟会话档位记录写入失败"), { code: "EIO" });
  const append = t.mock.method(inner.sessionManager, "appendThinkingLevelChange", level => {
    assert.equal(level, "off");
    assert.notStrictEqual(inner.model, previousModel, "复现时模型私有引用已经替换");
    assert.equal(inner.model.reasoning, false);
    assert.equal(inner.thinkingLevel, "off", "SDK 先改内存，再追加档位记录");
    throw writeError;
  });
  await assert.rejects(f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" }), error => error === writeError);
  assert.equal(append.mock.callCount(), 1);
  assert.strictEqual(inner.model, previousModel, "失败后必须恢复原模型引用及配置");
  assert.equal(inner.thinkingLevel, "high", "失败后必须恢复原档位");
  assert.deepEqual(modelEntries(inner), beforeEntries);
  assert.equal(await readFile(inner.sessionFile, "utf8"), beforeFile, "回滚不得追加补偿记录");
  assert.equal(await readFile(f.settingsPath, "utf8"), f.settingsBefore);
  append.mock.restore();
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.notStrictEqual(inner.model, previousModel);
  assert.equal(inner.model.reasoning, false);
  assert.equal(inner.model.contextWindow, 64000);
  assert.equal(inner.thinkingLevel, "off");
  assert.equal(modelEntries(inner).length, beforeEntries.length + 1, "成功重试只追加一次新档位");
});

for (const extensionChange of ["model", "thinking"]) test(`重选鉴权期间扩展 ${extensionChange} 已提交，重选失败须保留扩展结果`, async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  f.config.providers.synthetic.models[0].contextWindow = 64000;
  if (extensionChange === "thinking") f.config.providers.synthetic.models[0].reasoning = false;
  f.config.providers.synthetic.models.push({ id: "extension-target", reasoning: true, contextWindow: 48000, maxTokens: 1024 });
  f.save();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const runtime = inner.modelRuntime;
  const checkAuth = runtime.checkAuth;
  let first = true;
  t.mock.method(runtime, "checkAuth", async function (...args) {
    if (first) { first = false; entered(); await gate; }
    return checkAuth.apply(this, args);
  });
  const selection = f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  const writeError = Object.assign(new Error("模拟档位记录写入失败"), { code: "EIO" });
  const checkSelection = assert.rejects(selection, error => extensionChange === "model"
    ? /Fast 鉴权期间模型已变化/.test(error.message) : error === writeError);
  await reached;
  const target = extensionChange === "model" ? runtime.getModel("synthetic", "extension-target") : inner.model;
  assert.ok(target);
  // 扩展 API 的 setModel/setThinkingLevel 正是调用这两个 SDK 入口，不经过 wrapper 偏好队列。
  if (extensionChange === "model") await inner.setModel(target);
  inner.setThinkingLevel("medium");
  if (extensionChange === "thinking") t.mock.method(inner.sessionManager, "appendThinkingLevelChange", level => {
    assert.equal(level, "off");
    assert.equal(inner.model.reasoning, false, "已实际应用本次配置，再触发记录写入失败");
    throw writeError;
  });
  const entries = modelEntries(inner);
  const persisted = await readFile(inner.sessionFile, "utf8");
  release();
  await checkSelection;
  assert.strictEqual(inner.model, target, "重选失败不得撤销扩展已提交的模型或恢复到更早的档位");
  assert.equal(inner.thinkingLevel, "medium");
  assert.deepEqual(modelEntries(inner), entries);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
  assert.equal(f.wrapper.diskFreshness(), "current", "内存投影应继续与扩展写入的历史一致");
  if (extensionChange === "model") {
    await f.wrapper.send({ type: "set_fast_enabled", enabled: false });
    assert.equal(inner.model.id, target.id, "失败目标不得污染下一次 Fast 操作");
    assert.equal(inner.thinkingLevel, "medium");
    assert.deepEqual(modelEntries(inner), entries, "Fast 操作不得切回失败目标或新增档位记录");
  }
});

test("引用校验通过后、提交前的微任务切模也必须使重选拒绝", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  f.config.providers.synthetic.models[0].contextWindow = 64000;
  f.config.providers.synthetic.models.push({ id: "extension-target", reasoning: true, contextWindow: 48000, maxTokens: 1024 });
  f.save();
  let authenticated = false;
  let injected = false;
  let extensionSwitch;
  t.mock.method(inner.modelRuntime, "checkAuth", () => { authenticated = true; return true; });
  const inspect = f.wrapper.diskFreshness;
  t.mock.method(f.wrapper, "diskFreshness", function () {
    const result = inspect.call(this);
    if (authenticated && !injected) {
      injected = true;
      const target = inner.modelRuntime.getModel("synthetic", "extension-target");
      assert.ok(target);
      // SDK 的 await checkAuth 将 B 的提交排到微任务；此处 A 的首次引用校验仍会通过。
      extensionSwitch = inner.setModel(target).then(() => inner.setThinkingLevel("medium"));
      assert.strictEqual(inner.model, originalModel, "首次引用校验时仍是 A");
    }
    return result;
  });
  await assert.rejects(f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" }), /Fast 鉴权期间模型已变化/);
  assert.equal(injected, true);
  await extensionSwitch;
  assert.equal(inner.model.id, "extension-target");
  assert.equal(inner.thinkingLevel, "medium");
  assert.equal(modelEntries(inner).filter(entry => entry.type === "model_change").at(-1).modelId, "extension-target");
  assert.equal(f.wrapper.diskFreshness(), "current");
});

for (const targetId of ["extension-target", "primary"]) test(`同模型重选在出队前被扩展提交 ${targetId} 替换时必须拒绝`, async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  f.config.providers.synthetic.models[0].contextWindow = 64000;
  f.config.providers.synthetic.models.push({ id: "extension-target", reasoning: true, contextWindow: 48000, maxTokens: 1024 });
  f.save();
  t.mock.method(inner.modelRuntime, "checkAuth", () => true);
  let extensionSwitch;
  let target;
  const select = FastSessionSetting.prototype.selectModel;
  t.mock.method(FastSessionSetting.prototype, "selectModel", function (...args) {
    assert.strictEqual(inner.model, originalModel, "调用方已按 A 判定同身份重选");
    target = inner.modelRuntime.getModel("synthetic", targetId);
    assert.ok(target);
    // B 的 SDK 提交微任务先入队；Fast 自己的队列随后才出队，不能升级成真正切模。
    extensionSwitch = inner.setModel(target).then(() => inner.setThinkingLevel("medium"));
    return select.apply(this, args);
  });
  const sdkSetModel = t.mock.method(inner, "setModel");
  await assert.rejects(f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" }), /重选等待期间模型已变化/);
  await extensionSwitch;
  assert.equal(sdkSetModel.mock.callCount(), 1, "只能有扩展发起的一次 SDK 切模");
  assert.strictEqual(inner.model, target, "包括同 ID 的新引用也必须保留扩展提交");
  assert.equal(inner.thinkingLevel, "medium");
  assert.equal(modelEntries(inner).filter(entry => entry.type === "model_change").at(-1).modelId, targetId);
  assert.equal(f.wrapper.diskFreshness(), "current");
});

for (const rule of ["model-default", "previous", "clamped"]) test(`跨身份选模按真实 SDK 与服务端规则定档：${rule}`, async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  f.config.providers.synthetic.models.push({ id: "rule-target", reasoning: rule !== "clamped", contextWindow: 48000, maxTokens: 1024 });
  f.save();
  if (rule !== "previous") inner.settingsManager.setModelThinkingLevel("synthetic", "rule-target", "medium");
  const before = modelEntries(inner).length;
  assert.equal(inner.thinkingLevel, "high");
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "rule-target" });
  const expected = rule === "model-default" ? "medium" : rule === "clamped" ? "off" : "high";
  assert.equal(inner.model.id, "rule-target");
  assert.equal(inner.thinkingLevel, expected);
  const changes = modelEntries(inner).slice(before);
  assert.deepEqual(changes.filter(entry => entry.type === "model_change").map(entry => entry.modelId), ["rule-target"]);
  assert.equal(changes.filter(entry => entry.type === "thinking_level_change").at(-1).thinkingLevel, expected);
});

test("SDK 重载完成但快照未安装时拒绝重选，结束后允许重试", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  f.config.providers.synthetic.models[0].contextWindow = 64000;
  f.save();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const reload = inner.reload;
  t.mock.method(inner, "reload", async function (...args) {
    await reload.apply(this, args);
    entered();
    await gate;
  });
  const reloading = f.wrapper.send({ type: "reload" });
  await reached;
  const selection = f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  const [selected] = await Promise.allSettled([selection]);
  release();
  const [reloaded] = await Promise.allSettled([reloading]);
  assert.equal(reloaded.status, "fulfilled");
  assert.notEqual(selected.status, "fulfilled", "旧 generation 的重选不能假成功");
  assert.match(selected.reason.message, /模型配置已重载.*重试/);
  assert.strictEqual(inner.model, originalModel);
  assert.equal(inner.model.contextWindow, 32000);
  assert.equal(inner.thinkingLevel, "high");
  assert.equal((await f.wrapper.send({ type: "get_state" })).fastEnabled, false);
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.equal(inner.model.contextWindow, 64000);
  assert.equal(inner.thinkingLevel, "high");
});

for (const scenario of ["same", "different", "different-with-extension"]) test(`选模鉴权期间 reload 更新 generation 后拒绝旧配置：${scenario}`, async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  let before = modelEntries(inner);
  let persisted = await readFile(inner.sessionFile, "utf8");
  const targetId = scenario === "same" ? "primary" : "switch-target";
  if (targetId !== "primary") f.config.providers.synthetic.models.push({ id: targetId, reasoning: true, contextWindow: 64000, maxTokens: 1024 });
  f.config.providers.synthetic.models.push({ id: "extension-during-auth", reasoning: true, contextWindow: 48000, maxTokens: 1024 });
  const targetConfig = f.config.providers.synthetic.models.find(model => model.id === targetId);
  targetConfig.contextWindow = 64000;
  f.save();
  let expectedModel = originalModel;
  let expectedLevel = "high";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const runtime = inner.modelRuntime;
  const auth = runtime.checkAuth;
  let first = true;
  t.mock.method(runtime, "checkAuth", async function (...args) {
    if (first) { first = false; entered(); await gate; }
    return auth.apply(this, args);
  });
  const install = f.wrapper.installFastRuntimeSnapshot;
  let installed = false;
  t.mock.method(f.wrapper, "installFastRuntimeSnapshot", function (...args) {
    const result = install.apply(this, args);
    installed = true;
    release();
    return result;
  });
  const selection = f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: targetId });
  await reached;
  if (scenario === "different-with-extension") {
    const extensionModel = inner.modelRuntime.getModel("synthetic", "extension-during-auth");
    assert.ok(extensionModel);
    await inner.setModel(extensionModel);
    inner.setThinkingLevel("medium");
    expectedModel = inner.model;
    expectedLevel = "medium";
    before = modelEntries(inner);
    persisted = await readFile(inner.sessionFile, "utf8");
  }
  targetConfig.contextWindow = 96000;
  f.save();
  const reloading = f.wrapper.send({ type: "reload" });
  const [selected, reloaded] = await Promise.allSettled([selection, reloading]);
  assert.equal(installed, true, "由实际 reload 安装新 generation 后才恢复鉴权");
  assert.equal(reloaded.status, "fulfilled");
  assert.notEqual(selected.status, "fulfilled", "不能提交鉴权前捕获的 64000 配置");
  assert.match(selected.reason.message, /模型配置已重载.*重试/);
  assert.strictEqual(inner.model, expectedModel);
  assert.equal(inner.thinkingLevel, expectedLevel);
  assert.deepEqual(modelEntries(inner), before);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
  assert.equal((await f.wrapper.send({ type: "get_state" })).fastEnabled, false);
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: targetId });
  assert.equal(inner.model.contextWindow, 96000);
  assert.equal(inner.thinkingLevel, expectedLevel);
});

test("网页选模等待鉴权时，扩展的成功鉴权仍须检查外部会话写入", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  const before = modelEntries(inner);
  for (const id of ["switch-target", "extension-target"]) f.config.providers.synthetic.models.push({ id, reasoning: true, contextWindow: 64000, maxTokens: 1024 });
  f.save();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const runtime = inner.modelRuntime;
  let first = true;
  t.mock.method(runtime, "checkAuth", async () => { if (first) { first = false; entered(); await gate; } return true; });
  const selection = f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "switch-target" });
  await reached;
  await appendFile(inner.sessionFile, `${JSON.stringify({ type: "custom", id: "outside-during-auth", parentId: inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
  const persisted = await readFile(inner.sessionFile, "utf8");
  const extensionModel = runtime.getModel("synthetic", "extension-target");
  assert.ok(extensionModel);
  const [extension] = await Promise.allSettled([inner.setModel(extensionModel)]);
  release();
  const [selected] = await Promise.allSettled([selection]);
  assert.notEqual(extension.status, "fulfilled", "并发扩展不能从旧叶节点追加模型历史");
  assert.equal(extension.reason.name, "SessionFileConflictError");
  assert.notEqual(selected.status, "fulfilled");
  assert.equal(selected.reason.name, "SessionFileConflictError");
  assert.strictEqual(inner.model, originalModel);
  assert.equal(inner.thinkingLevel, "high");
  assert.deepEqual(modelEntries(inner), before);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
});

test("reload 安装快照排在鉴权检查与 SDK 提交之间时，旧选模必须拒绝", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const originalModel = inner.model;
  const before = modelEntries(inner);
  const persisted = await readFile(inner.sessionFile, "utf8");
  const target = { id: "switch-target", reasoning: true, contextWindow: 64000, maxTokens: 1024 };
  f.config.providers.synthetic.models.push(target);
  f.save();
  let releaseAuth, releaseReload;
  const authGate = new Promise(resolve => { releaseAuth = resolve; });
  const reloadGate = new Promise(resolve => { releaseReload = resolve; });
  t.after(() => { releaseAuth(); releaseReload(); });
  let enteredAuth, enteredReload;
  const authReached = new Promise(resolve => { enteredAuth = resolve; });
  const reloadReached = new Promise(resolve => { enteredReload = resolve; });
  const events = [];
  let first = true;
  t.mock.method(inner.modelRuntime, "checkAuth", async () => {
    if (first) {
      first = false; enteredAuth(); await authGate;
      events.push("auth-resumed");
      releaseReload();
    }
    return true;
  });
  const reload = inner.reload;
  t.mock.method(inner, "reload", async function (...args) {
    await reload.apply(this, args); enteredReload(); await reloadGate;
  });
  const inspect = f.wrapper.diskFreshness;
  t.mock.method(f.wrapper, "diskFreshness", function () {
    if (events.includes("auth-resumed") && !events.includes("checked")) events.push("checked");
    return inspect.call(this);
  });
  const install = f.wrapper.installFastRuntimeSnapshot;
  t.mock.method(f.wrapper, "installFastRuntimeSnapshot", function (...args) {
    const result = install.apply(this, args); events.push("installed"); return result;
  });
  const append = inner.sessionManager.appendModelChange;
  t.mock.method(inner.sessionManager, "appendModelChange", function (...args) {
    events.push("model-write"); return append.apply(this, args);
  });
  const selection = f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "switch-target" });
  await authReached;
  target.contextWindow = 96000; f.save();
  const reloading = f.wrapper.send({ type: "reload" });
  await reloadReached;
  releaseAuth();
  const [selected, reloaded] = await Promise.allSettled([selection, reloading]);
  assert.equal(reloaded.status, "fulfilled");
  assert.ok(events.indexOf("checked") >= 0 && events.indexOf("checked") < events.indexOf("installed"), "安装恰在鉴权检查之后，不能仅依赖当时的 generation");
  assert.notEqual(selected.status, "fulfilled");
  assert.match(selected.reason.message, /模型配置已重载.*重试/);
  assert.ok(!events.includes("model-write"), "失败的旧任务不能追加模型历史");
  assert.strictEqual(inner.model, originalModel);
  assert.equal(inner.thinkingLevel, "high");
  assert.deepEqual(modelEntries(inner), before);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "switch-target" });
  assert.equal(inner.model.contextWindow, 96000);
});

test("reload 失败也会撤销进行中标记，之后可重试选模", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  const reload = t.mock.method(inner, "reload", async () => { throw new Error("模拟重载失败"); });
  await assert.rejects(f.wrapper.send({ type: "reload" }), /模拟重载失败/);
  reload.mock.restore();
  f.config.providers.synthetic.models[0].contextWindow = 64000; f.save();
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.equal(inner.model.contextWindow, 64000);
  assert.equal(inner.thinkingLevel, "high");
});

test("排队的重载在最后一个结束前持续拒绝显式选模", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  f.config.providers.synthetic.models[0].contextWindow = 64000; f.save();
  const release = [];
  const gates = [0, 1].map(index => new Promise(resolve => { release[index] = resolve; }));
  t.after(() => release.forEach(resolve => resolve()));
  let enteredFirst, enteredSecond, queued;
  const firstReached = new Promise(resolve => { enteredFirst = resolve; });
  const secondReached = new Promise(resolve => { enteredSecond = resolve; });
  const bothQueued = new Promise(resolve => { queued = resolve; });
  let calls = 0, requests = 0;
  t.mock.method(inner, "reload", async () => {
    const index = calls++;
    if (calls === 1) enteredFirst(); else enteredSecond();
    await gates[index];
  });
  const reload = f.wrapper.reloadRuntime;
  t.mock.method(f.wrapper, "reloadRuntime", function (...args) {
    const task = reload.apply(this, args);
    if (++requests === 2) queued();
    return task;
  });
  const first = f.wrapper.send({ type: "reload" });
  await firstReached;
  const second = f.wrapper.send({ type: "reload" });
  await bothQueued;
  assert.equal(calls, 1, "第二个 SDK reload 不能越过第一个");
  release[0]();
  await secondReached;
  await first;
  const [selection] = await Promise.allSettled([f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" })]);
  release[1]();
  await second;
  assert.notEqual(selection.status, "fulfilled", "排队重载未结束时不能提前解除阻塞");
  assert.match(selection.reason.message, /模型配置已重载.*重试/);
  assert.equal(inner.model.contextWindow, 32000);
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.equal(inner.model.contextWindow, 64000);
});

test("配置未变的重选也必须在重载进行中拒绝，结束后无写入地成功", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  const originalModel = inner.model;
  const before = modelEntries(inner);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  t.mock.method(inner, "reload", async () => { entered(); await gate; });
  const reloading = f.wrapper.send({ type: "reload" });
  await reached;
  const [selection] = await Promise.allSettled([f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" })]);
  release();
  await reloading;
  assert.notEqual(selection.status, "fulfilled", "深度相等不能绕过重载检查");
  assert.match(selection.reason.message, /模型配置已重载.*重试/);
  assert.equal(selection.reason.retryable, true);
  assert.equal(selection.reason.code, "model_runtime_reload_conflict");
  assert.strictEqual(inner.model, originalModel);
  await f.wrapper.send({ type: "set_model", provider: "synthetic", modelId: "primary" });
  assert.strictEqual(inner.model, originalModel);
  assert.deepEqual(modelEntries(inner), before);
});

test("第二次重载出队前发生外部追加时，不能用旧叶节点执行扩展写入", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const before = modelEntries(inner);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered, queued;
  const reached = new Promise(resolve => { entered = resolve; });
  const bothQueued = new Promise(resolve => { queued = resolve; });
  let calls = 0, requests = 0;
  t.mock.method(inner, "reload", async options => {
    await options?.beforeSessionStart?.();
    if (++calls === 1) { entered(); await gate; }
    else inner.sessionManager.appendCustomEntry("reload-session-start", { source: "extension" });
  });
  const reload = f.wrapper.reloadRuntime;
  t.mock.method(f.wrapper, "reloadRuntime", function (...args) {
    const task = reload.apply(this, args);
    if (++requests === 2) queued();
    return task;
  });
  const first = f.wrapper.send({ type: "reload" });
  await reached;
  const second = f.wrapper.send({ type: "reload" });
  await bothQueued;
  await appendFile(inner.sessionFile, `${JSON.stringify({ type: "custom", id: "outside-while-reload-queued", parentId: inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
  const persisted = await readFile(inner.sessionFile, "utf8");
  release();
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, "fulfilled");
  assert.notEqual(secondResult.status, "fulfilled");
  assert.equal(secondResult.reason.name, "SessionFileConflictError");
  assert.equal(calls, 1, "失效的第二次重载不能再调用 SDK session_start");
  assert.deepEqual(modelEntries(inner), before);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted, "外部分支之后不能追加旧叶节点记录");
});

for (const secondEntry of ["rpc", "command"]) test(`第二个 ${secondEntry} 重载在执行前清理第一个刚注册的组件和状态`, async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  const ui = f.wrapper.createExtensionUiContext();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let entered, queued;
  const reached = new Promise(resolve => { entered = resolve; });
  const bothQueued = new Promise(resolve => { queued = resolve; });
  let calls = 0, requests = 0, disposed = 0;
  let oldTui;
  t.mock.method(inner, "reload", async options => {
    if (++calls === 1) {
      entered(); await gate;
      await options?.beforeSessionStart?.();
      ui.setStatus("removed-extension", "first reload");
      ui.setWidget("removed-array", ["first reload"]);
      ui.setWidget("removed-factory", tui => {
        oldTui = tui;
        return { render: () => ["first reload"], dispose: () => { disposed += 1; } };
      });
    }
    if (calls !== 1) await options?.beforeSessionStart?.();
    // 第二次相当于该扩展已移除，不注册任何组件。
  });
  const reload = f.wrapper.reloadRuntime;
  t.mock.method(f.wrapper, "reloadRuntime", function (...args) {
    const task = reload.apply(this, args);
    if (++requests === 2) queued();
    return task;
  });
  const run = entry => entry === "rpc" ? f.wrapper.send({ type: "reload" }) : f.wrapper.createExtensionCommandContextActions().reload();
  const first = run(secondEntry === "rpc" ? "command" : "rpc");
  await reached;
  const second = run(secondEntry);
  await bothQueued;
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(disposed, 1, "第一次 session_start 的工厂组件必须由第二次执行前清理");
  const state = await f.wrapper.send({ type: "get_state" });
  assert.deepEqual(state.extensionStatuses, []);
  assert.deepEqual(state.extensionWidgets, []);
  oldTui.requestRender();
  assert.deepEqual((await f.wrapper.send({ type: "get_state" })).extensionWidgets, [], "旧组件回调不能重新挂载");
});
