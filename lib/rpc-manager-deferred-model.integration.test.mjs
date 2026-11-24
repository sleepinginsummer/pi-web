import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// startRpcSession() builds real SDK sessions here; keep them out of ~/.pi.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const root = await mkdtemp(join(tmpdir(), "pi-web-deferred-model-"));
process.env.HOME = root;
process.env.USERPROFILE = root;

const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": process.cwd() } });
const { rememberProviderModels } = await jiti.import("./deferred-provider-models.ts");
const { startRpcSession, setRpcSessionTools } = await jiti.import("./rpc-manager.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.__piWebProviderModelCatalog = undefined;
  globalThis.__piWebTestDeferredProviderSeen = undefined;
});

const MODEL_FIELDS = `input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100`;

// As pi-claude-bridge does: the first runtime of the process registers the provider, later ones
// at session_start, so a session's runtime lacks it while the session is built.
const DEFERRING_EXTENSION = `export default function (pi) {
  const register = () => pi.registerProvider("bridge", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "bridge-opus", name: "Bridge Opus", reasoning: true, ${MODEL_FIELDS} }] });
  if (globalThis.__piWebTestDeferredProviderSeen) pi.on("session_start", register);
  else { globalThis.__piWebTestDeferredProviderSeen = true; register(); }
}
`;

const PLAIN_EXTENSION = `export default function (pi) {
  pi.registerProvider("plain", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "plain-model", name: "Plain", reasoning: true, ${MODEL_FIELDS} }] });
}
`;

// A models.json provider is in every runtime: the model a session is built on meanwhile.
const MODELS_JSON = {
  providers: {
    local: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "dummy",
      api: "openai-completions",
      models: [
        { id: "local-model", name: "Local", reasoning: false, contextWindow: 1000, maxTokens: 100 },
        { id: "local-think", name: "Local Think", reasoning: true, contextWindow: 1000, maxTokens: 100 },
      ],
    },
  },
};

async function agentDir(settings, extension = DEFERRING_EXTENSION) {
  const dir = await mkdtemp(join(root, "agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(join(dir, "extensions", "provider.ts"), extension);
  await writeFile(join(dir, "models.json"), JSON.stringify(MODELS_JSON));
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  // The model selector's listing loads extensions and remembers their models, as /api/models does.
  const listing = await createAgentSessionServices({ cwd: dir, agentDir: dir });
  await rememberProviderModels(listing.modelRuntime);
  return dir;
}

async function start(t, dir, options = {}, wait = true) {
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", dir, options);
  t.after(() => session.shutdown());
  // pi-web 在扩展绑定后于后台切换延迟模型（新会话 create 阶段不等待扩展）。
  if (wait) await session.waitForStartupModelSwitch();
  const modelChanges = session.inner.sessionManager.getEntries()
    .filter((entry) => entry.type === "model_change")
    .map((entry) => `${entry.provider}/${entry.modelId}`);
  return { session, realSessionId, model: `${session.inner.model?.provider}/${session.inner.model?.id}`, modelChanges };
}

test("普通模型不等待后台目录发现，扩展审批仍由独立绑定状态表示", { timeout: 10_000 }, async (t) => {
  let release;
  globalThis.__piWebTestBindingGate = new Promise((resolve) => { release = resolve; });
  const dir = await agentDir({ defaultProvider: "local", defaultModel: "local-model" },
    'export default function(pi) { pi.on("session_start", () => globalThis.__piWebTestBindingGate); }');
  const { session } = await startRpcSession(`__new__${randomUUID()}`, "", dir);
  t.after(async () => { release(); await session.shutdown(); delete globalThis.__piWebTestBindingGate; });
  await session.waitForStartupModelSwitch();
  assert.equal(session.extensionsInitializing, true);
  assert.equal(session.extensionsError, null);
  release();
  await session.waitUntilReady();
});

test("a failed deferred provider blocks initialization and prompts until an explicit model choice succeeds", async (t) => {
  // 列表曾发现该 provider，但后续 runtime 的 session_start 初始化失败。
  const extension = DEFERRING_EXTENSION.replace(
    'pi.on("session_start", register)',
    'pi.on("session_start", () => { throw new Error("bridge initialization failed"); })',
  );
  const dir = await agentDir(THINKING_SETTINGS, extension);
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", dir, {
    initialModel: { provider: "bridge", modelId: "bridge-opus" },
  });
  t.after(() => session.shutdown());
  await assert.rejects(session.waitForStartupModelSwitch(), /Model not found: bridge\/bridge-opus/);
  assert.match(session.extensionsError, /Model not found/);
  assert.equal(session.extensionsInitializing, false);
  const { POST } = await jiti.import("../app/api/agent/new/route.ts");
  const finalize = () => POST(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: dir, type: "ensure_session", operation: "finalize-existing", sessionId: realSessionId }),
  }));
  const failed = await finalize();
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.kind, "materialization-failed");
  assert.equal(failedBody.sessionId, realSessionId, "初始化失败保留同一个 runtime 身份");
  // 任务结束后仍拒绝发送，不能因 finally 清掉 Promise 就遗失错误。
  await assert.rejects(session.send({ type: "prompt", message: "private content" }), /Model not found/);
  assert.equal(session.inner.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user"), false);
  await assert.rejects(session.send({ type: "set_model", provider: "missing", modelId: "missing" }), /Model not found/);
  await assert.rejects(session.waitForStartupModelSwitch(), /Model not found: bridge/);
  await session.send({ type: "set_model", provider: "local", modelId: "local-model" });
  await session.waitForStartupModelSwitch();
  assert.equal(session.extensionsError, null);
  const recovered = await finalize();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).kind, "ready");
});

test("a new session asking for no model switches to a default only an extension's session_start registers (#1240)", async (t) => {
  const dir = await agentDir({
    defaultProvider: "bridge",
    defaultModel: "bridge-opus",
    enabledModels: ["local/local-model", "bridge/bridge-opus"],
  });
  const { model, modelChanges } = await start(t, dir);
  assert.equal(model, "bridge/bridge-opus");
  assert.deepEqual(modelChanges, ["local/local-model", "bridge/bridge-opus"]);
});

test("with no enabledModels the deferred default is switched to as well", async (t) => {
  const dir = await agentDir({ defaultProvider: "bridge", defaultModel: "bridge-opus" });
  const { model } = await start(t, dir);
  assert.equal(model, "bridge/bridge-opus");
});

test("a deferred default outside the enabledModels scope is passed over, as a registered one is", async (t) => {
  const dir = await agentDir({
    defaultProvider: "bridge",
    defaultModel: "bridge-opus",
    enabledModels: ["local/local-model"],
  });
  const { model, modelChanges } = await start(t, dir);
  assert.equal(model, "local/local-model");
  assert.deepEqual(modelChanges, ["local/local-model"]);
});

test("a registered default is passed over when enabledModels names only deferred models", async (t) => {
  // The scope resolves to nothing without the deferred models, so the session starts on the
  // default; /api/models resolves it to bridge-opus and pre-selects that.
  const dir = await agentDir({ defaultProvider: "local", defaultModel: "local-model", enabledModels: ["bridge/bridge-opus"] });
  const { model } = await start(t, dir);
  assert.equal(model, "bridge/bridge-opus");
});

test("a default the session's runtime registers itself needs no switch", async (t) => {
  const dir = await agentDir({
    defaultProvider: "plain",
    defaultModel: "plain-model",
    enabledModels: ["local/local-model", "plain/plain-model"],
  }, PLAIN_EXTENSION);
  const { model, modelChanges } = await start(t, dir);
  assert.equal(model, "plain/plain-model");
  assert.deepEqual(modelChanges, ["plain/plain-model"]);
});

test("a usable requested model wins over a deferred default", async (t) => {
  const dir = await agentDir({
    defaultProvider: "bridge",
    defaultModel: "bridge-opus",
    enabledModels: ["local/local-model", "bridge/bridge-opus"],
  });
  const { model, modelChanges } = await start(t, dir, { initialModel: { provider: "local", modelId: "local-model" } });
  assert.equal(model, "local/local-model");
  assert.deepEqual(modelChanges, ["local/local-model"]);
});

// set_model alone applies settings' defaultThinkingLevel, and the stand-in model cannot think.
const THINKING_SETTINGS = {
  defaultProvider: "bridge",
  defaultModel: "bridge-opus",
  defaultThinkingLevel: "low",
  enabledModels: ["local/local-model", "bridge/bridge-opus"],
};

test("a requested thinking level survives the switch to a deferred default", async (t) => {
  const { session, model } = await start(t, await agentDir(THINKING_SETTINGS), { thinkingLevel: "high" });
  assert.equal(model, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
});

test("a requested thinking level survives the switch to a deferred model the browser chose", async (t) => {
  const { session, model } = await start(t, await agentDir(THINKING_SETTINGS), {
    initialModel: { provider: "bridge", modelId: "bridge-opus" },
    thinkingLevel: "high",
  });
  assert.equal(model, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
});

test("the deferred default's enabledModels thinking pin applies after the switch", async (t) => {
  const dir = await agentDir({
    defaultProvider: "bridge",
    defaultModel: "bridge-opus",
    defaultThinkingLevel: "low",
    enabledModels: ["local/local-model", "bridge/bridge-opus:high"],
  });
  const { session, model } = await start(t, dir);
  assert.equal(model, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
});

for (const [standIn, enabledModels] of [
  ["cannot think", ["local/local-model", "bridge/bridge-opus"]],
  ["has its own pin", ["local/local-think:low", "bridge/bridge-opus"]],
]) {
  test(`with no level asked for or pinned, a deferred default whose stand-in ${standIn} gets pi's startup level`, async (t) => {
    // set_model alone would keep the stand-in's level: off, or its pin.
    const settings = { defaultProvider: "bridge", defaultModel: "bridge-opus", enabledModels };
    const unset = await start(t, await agentDir(settings));
    assert.equal(unset.model, "bridge/bridge-opus");
    assert.equal(unset.session.inner.thinkingLevel, "medium");

    const configured = await start(t, await agentDir({ ...settings, defaultThinkingLevel: "high" }));
    assert.equal(configured.session.inner.thinkingLevel, "high");
  });
}

test("a deferred model the browser chose gets its enabledModels pin with no level asked for", async (t) => {
  const dir = await agentDir({ ...THINKING_SETTINGS, enabledModels: ["local/local-model", "bridge/bridge-opus:high"] });
  const { session, model } = await start(t, dir, { initialModel: { provider: "bridge", modelId: "bridge-opus" } });
  assert.equal(model, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
});

test("a reopened session whose saved model is deferred keeps its saved thinking level", async (t) => {
  const dir = await agentDir(THINKING_SETTINGS);
  const first = await start(t, dir, { thinkingLevel: "high" });
  assert.equal(first.session.inner.thinkingLevel, "high");
  first.session.inner.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  const sessionFile = first.session.inner.sessionFile;
  await first.session.shutdown();

  const { session } = await startRpcSession(first.realSessionId, sessionFile, undefined);
  t.after(() => session.shutdown());
  await session.waitForStartupModelSwitch();
  assert.equal(`${session.inner.model?.provider}/${session.inner.model?.id}`, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
});

// Registers the provider for the first runtime of the process only: a session's switch back to it fails.
const ONCE_EXTENSION = `export default function (pi) {
  if (globalThis.__piWebTestDeferredProviderSeen) return;
  globalThis.__piWebTestDeferredProviderSeen = true;
  pi.registerProvider("bridge", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "bridge-opus", name: "Bridge Opus", reasoning: true, ${MODEL_FIELDS} }] });
}
`;

// A session saved on bridge/bridge-opus, opened again as the events route does, and what it tells a stream.
async function reopenSavedOnDeferredModel(t, extension) {
  const dir = await agentDir({ defaultProvider: "local", defaultModel: "local-model" }, extension);
  const first = await start(t, dir);
  first.session.inner.sessionManager.appendModelChange("bridge", "bridge-opus");
  first.session.inner.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  const sessionFile = first.session.inner.sessionFile;
  await first.session.shutdown();
  const { session } = await startRpcSession(first.realSessionId, sessionFile, undefined);
  t.after(() => session.shutdown());
  const notices = [];
  session.onEvent((event) => {
    if (event.method === "notify") notices.push(`${event.notifyType}: ${event.message}`);
  });
  await session.waitForStartupModelSwitch().catch(() => { /* 验证切换失败时向页面报告当前模型。 */ });
  return { model: `${session.inner.model?.provider}/${session.inner.model?.id}`, notices };
}

test("a reopened session reached its deferred model again: pi's 'Could not restore model' is not told", async (t) => {
  const { model, notices } = await reopenSavedOnDeferredModel(t, DEFERRING_EXTENSION);
  assert.equal(model, "bridge/bridge-opus");
  assert.deepEqual(notices, []);
});

test("a reopened session whose deferred model never came back tells of the model it uses instead", async (t) => {
  const { model, notices } = await reopenSavedOnDeferredModel(t, ONCE_EXTENSION);
  assert.equal(model, "local/local-model");
  assert.deepEqual(notices, ["warning: Could not restore model bridge/bridge-opus. Using local/local-model"]);
});

// As DEFERRING_EXTENSION, and session_start then asks a dialog (#1678).
const ASKING_EXTENSION = `export default function (pi) {
  const register = () => pi.registerProvider("bridge", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "bridge-opus", name: "Bridge Opus", reasoning: true, ${MODEL_FIELDS} }] });
  if (globalThis.__piWebTestDeferredProviderSeen) pi.on("session_start", register);
  else { globalThis.__piWebTestDeferredProviderSeen = true; register(); }
  pi.on("session_start", async (_event, ctx) => { await ctx.ui.confirm("Use project defaults?", "x"); });
}
`;

test("a start on a deferred model answers while session_start waits on a dialog, and switches once it is answered", async (t) => {
  const dir = await agentDir(THINKING_SETTINGS, ASKING_EXTENSION);
  const { session, model } = await start(t, dir, { thinkingLevel: "high" }, false);
  // The page opens the stream that shows the dialog only once the start has answered.
  assert.equal(model, "local/local-model");
  const dialogs = [];
  session.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "confirm") dialogs.push(event);
  });
  assert.equal(dialogs.length, 1);
  assert.deepEqual((await session.send({ type: "get_state" })).model, { id: "local-model", provider: "local" });

  await session.send({ type: "extension_ui_response", id: dialogs[0].id, confirmed: true });
  await session.waitUntilReady();
  assert.equal(`${session.inner.model?.provider}/${session.inner.model?.id}`, "bridge/bridge-opus");
  assert.equal(session.inner.thinkingLevel, "high");
  assert.deepEqual((await session.send({ type: "get_state" })).model, { id: "bridge-opus", provider: "bridge" });
});

/** The confirm a session's session_start waits on, answered. */
async function answerStartDialog(session) {
  const dialogs = [];
  const unsubscribe = session.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "confirm") dialogs.push(event);
  });
  unsubscribe();
  assert.equal(dialogs.length, 1);
  await session.send({ type: "extension_ui_response", id: dialogs[0].id, confirmed: true });
  await session.waitUntilReady();
}

test("a tool change while session_start's dialog holds the switch rebuilds on the deferred model", async (t) => {
  const dir = await agentDir(THINKING_SETTINGS, ASKING_EXTENSION);
  const { session, realSessionId, model } = await start(t, dir, { thinkingLevel: "high" }, false);
  assert.equal(model, "local/local-model");

  // Clearing the selection rebuilds a fresh session (the Tools panel's preset change).
  const changed = await setRpcSessionTools(realSessionId, undefined, undefined);
  t.after(() => changed.session.shutdown());
  assert.equal(changed.recreated, true);
  assert.equal(session.isAlive(), false);
  await answerStartDialog(changed.session);
  assert.equal(`${changed.session.inner.model?.provider}/${changed.session.inner.model?.id}`, "bridge/bridge-opus");
  assert.equal(changed.session.inner.thinkingLevel, "high");
});

test("a model picked while session_start's dialog holds the switch stands", async (t) => {
  const dir = await agentDir(THINKING_SETTINGS, ASKING_EXTENSION);
  const { session } = await start(t, dir, { thinkingLevel: "high" }, false);
  await session.send({ type: "set_model", provider: "local", modelId: "local-think" });
  await answerStartDialog(session);
  assert.equal(`${session.inner.model?.provider}/${session.inner.model?.id}`, "local/local-think");
  assert.deepEqual(
    session.inner.sessionManager.getEntries().filter((entry) => entry.type === "model_change").map((entry) => entry.modelId),
    ["local-model", "local-think"],
  );
});

for (const manual of [false, true]) test(`启动选模的临时重载冲突自动恢复并尊重手动选择：manual=${manual}`, async (t) => {
  let releaseBinding, releaseAuth;
  globalThis.__piWebTestStartupReloadGate = new Promise(resolve => { releaseBinding = resolve; });
  const authGate = new Promise(resolve => { releaseAuth = resolve; });
  t.after(() => { releaseBinding(); releaseAuth(); delete globalThis.__piWebTestStartupReloadGate; });
  const extension = DEFERRING_EXTENSION.replace('pi.on("session_start", register)',
    'pi.on("session_start", async () => { register(); await globalThis.__piWebTestStartupReloadGate; })');
  const dir = await agentDir({ ...THINKING_SETTINGS, retry: { enabled: false }, compaction: { enabled: false } }, extension);
  const { session } = await start(t, dir, { thinkingLevel: "high" }, false);
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const runtime = session.inner.modelRuntime;
  const auth = runtime.checkAuth;
  let first = true;
  t.mock.method(runtime, "checkAuth", async function (provider, ...args) {
    if (provider === "bridge" && first) { first = false; entered(); await authGate; }
    return auth.call(this, provider, ...args);
  });
  const errors = [];
  session.onEvent(event => { if (event.type === "extensions_error") errors.push(event.errorMessage); });
  let manualOutcome;
  const install = session.installFastRuntimeSnapshot;
  t.mock.method(session, "installFastRuntimeSnapshot", function (...args) {
    const result = install.apply(this, args);
    if (manual) manualOutcome = session.send({ type: "set_model", provider: "local", modelId: "local-think" }).then(() => null, error => error);
    releaseAuth();
    return result;
  });
  releaseBinding();
  await reached;
  const reloading = session.send({ type: "reload" });
  await Promise.all([reloading, session.waitUntilReady()]);
  if (manual) assert.equal(await manualOutcome, null);
  assert.equal(session.extensionsError, null, "临时冲突不能固化成启动错误");
  assert.equal(session.extensionsInitializing, false);
  assert.deepEqual(errors, []);
  assert.equal(session.inner.model.provider, manual ? "local" : "bridge");
  assert.equal(session.inner.model.id, manual ? "local-think" : "bridge-opus");
  if (!manual) assert.equal(session.inner.thinkingLevel, "high");
  else assert.ok(!session.inner.sessionManager.getEntries().some(entry => entry.type === "model_change" && entry.provider === "bridge"), "旧启动目标不能覆盖手动选模");
  // 只验证普通 prompt 已通过启动屏障并送达 SDK，模型传输与自动命名不属于此回归。
  let submitted = 0;
  t.mock.method(session.inner, "prompt", async (text, options) => {
    assert.equal(text, "startup recovered");
    submitted += 1;
    options.preflightResult("handled");
  });
  await session.send({ type: "prompt", message: "startup recovered" });
  assert.equal(submitted, 1);
});
