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
const root = await mkdtemp(join(tmpdir(), "pi-web-deferred-model-"));
process.env.HOME = root;

const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": process.cwd() } });
const { rememberProviderModels } = await jiti.import("./deferred-provider-models.ts");
const { startRpcSession } = await jiti.import("./rpc-manager.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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

async function start(t, dir, options = {}) {
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", dir, options);
  t.after(() => session.shutdown());
  // pi-web 在扩展绑定后于后台切换延迟模型（新会话 create 阶段不等待扩展）。
  await session.waitForStartupModelSwitch();
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
