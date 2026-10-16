import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";

const original = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_WEB_EXTENSION_BINDING_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
const root = await mkdtemp(join(tmpdir(), "pi-startup-retry-"));
process.env.HOME = root;
// 只缩短请求的等待期限，后台审批没有截止期限；不让回归测试真的等待 20 秒。
process.env.PI_WEB_EXTENSION_BINDING_TIMEOUT_MS = "500";
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": process.cwd() } });
const { rememberProviderModels } = await jiti.import("./deferred-provider-models.ts");
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { POST } = await jiti.import("../app/api/agent/new/route.ts");
const { materializeNewSession, releaseNewSessionMaterialization } = await jiti.import("./new-session-materialization-client.ts");

after(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  globalThis.__piWebProviderModelCatalog = undefined;
  globalThis.__startupRetryProviderSeen = undefined;
  globalThis.__startupRetryProviderAvailable = true;
  globalThis.__startupRetryRegister = undefined;
});

async function fixture(t) {
  const cwd = await mkdtemp(join(root, "agent-"));
  process.env.PI_CODING_AGENT_DIR = cwd;
  await mkdir(join(cwd, "extensions"));
  await writeFile(join(cwd, "models.json"), JSON.stringify({ providers: { local: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture",
    models: [
      { id: "standin", name: "Stand-in", reasoning: false, contextWindow: 1000, maxTokens: 100 },
      { id: "manual", name: "Manual choice", reasoning: true, contextWindow: 1000, maxTokens: 100 },
    ],
  } } }));
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "standin" }));
  await writeFile(join(cwd, "extensions/provider.ts"), `export default function(pi) {
    const register = () => pi.registerProvider("bridge", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture",
      models: [{ id: "wanted", name: "Wanted", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    });
    if (!globalThis.__startupRetryProviderSeen) {
      globalThis.__startupRetryProviderSeen = true;
      register();
    } else {
      pi.on("session_start", async (_, ctx) => {
        if (await ctx.ui.confirm("Allow provider?", "Startup retry fixture")) {
          globalThis.__startupRetryRegister = register;
          if (globalThis.__startupRetryProviderAvailable) register();
        }
      });
    }
  }`);
  const listing = await createAgentSessionServices({ cwd, agentDir: cwd });
  await rememberProviderModels(listing.modelRuntime);
  const operations = [];
  const originalFetch = globalThis.fetch;
  // 只替换 HTTP 传输；create/finalize 路由、真实 SDK、审批和浏览器请求去重逻辑全部执行。
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    operations.push(body.operation);
    return POST(new Request("http://localhost/api/agent/new", init));
  };
  let session;
  let approval;
  let approvalReady;
  const approvalSeen = new Promise((resolve) => { approvalReady = resolve; });
  let unsubscribe;
  const events = [];
  const attach = async (sid) => {
    if (session) { assert.equal(session.sessionId, sid); return; }
    session = getRpcSession(sid);
    assert.ok(session);
    await new Promise((resolve) => {
      unsubscribe = session.onEvent((event) => {
        events.push(event);
        if (event.type === "extension_ui_request" && event.method === "confirm") {
          approval = event;
          approvalReady();
          resolve();
        }
      });
    });
  };
  const create = () => materializeNewSession({
    operation: "create", cwd, model: { provider: "bridge", modelId: "wanted" }, thinkingLevel: "high", shadowMindEnabled: false,
  }, attach);
  const retry = (sid) => {
    // 对应 useAgentSession 在 materialization-failed 提交后的共享请求释放。
    releaseNewSessionMaterialization(cwd);
    return materializeNewSession({ operation: "finalize-existing", sessionId: sid, cwd, shadowMindEnabled: false }, attach);
  };
  t.after(async () => {
    if (approval) await session.send({ type: "extension_ui_response", id: approval.id, confirmed: false });
    unsubscribe?.();
    if (session) await session.shutdown();
    releaseNewSessionMaterialization(cwd);
    globalThis.fetch = originalFetch;
    delete globalThis.__startupRetryRegister;
  });
  return {
    cwd, create, retry, operations, events,
    // 恢复真实的已发送会话：这类会话在扩展审批期间仍允许用户选择模型或强度。
    restore: async () => {
      const persisted = SessionManager.create(cwd, join(cwd, "sessions"));
      persisted.appendModelChange("bridge", "wanted");
      persisted.appendThinkingLevelChange("high");
      persisted.appendMessage({ role: "user", content: "Existing session fixture", timestamp: Date.now() });
      const restored = await startRpcSession(persisted.getSessionId(), persisted.getSessionFile(), undefined);
      await attach(restored.realSessionId);
    },
    get session() { return session; },
    waitForApproval: () => approvalSeen,
    approve: async () => {
      await session.send({ type: "extension_ui_response", id: approval.id, confirmed: true });
      approval = null;
    },
  };
}

test("审批超过请求期限后仍完成后台切模，界面重试复用同一 runtime 并恢复 ready", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  assert.equal(first.kind, "materialization-failed");
  assert.match(first.error, /模型初始化超过/);
  assert.equal(f.session.extensionsInitializing, true);
  assert.equal(f.session.extensionsError, null, "请求超时不得变成后台初始化错误");
  assert.equal(f.session.inner.model.provider, "local");
  assert.equal(f.events.filter((event) => event.method === "confirm").length, 1);
  assert.equal(f.events.some((event) => event.type === "extensions_error"), false);
  await f.approve();
  await f.session.whenExtensionsBound();
  await f.session.waitForStartupModelSwitch();
  const result = await f.retry(first.sessionId);
  assert.equal(result.kind, "ready");
  assert.equal(result.sessionId, first.sessionId);
  assert.deepEqual(result.model, { provider: "bridge", modelId: "wanted" });
  assert.equal(result.thinkingLevel, "high");
  assert.deepEqual(f.operations, ["create", "finalize-existing", "finalize-existing"]);
  assert.equal(f.session.extensionsError, null);
});

test("真实切模失败仍阻止发送，模型恢复后并发 finalize 仅重做一次目标初始化", { timeout: 20_000 }, async (t) => {
  globalThis.__startupRetryProviderAvailable = false;
  const f = await fixture(t);
  const firstPromise = f.create();
  // 连接回调交付审批后再明确批准；不通过定时器猜测 session_start 的进度。
  await f.waitForApproval();
  await f.approve();
  const first = await firstPromise;
  assert.equal(first.kind, "materialization-failed");
  assert.match(first.error, /Model not found: bridge\/wanted/);
  await assert.rejects(f.session.send({ type: "prompt", message: "private content" }), /Model not found/);
  // 模拟已获准的 provider 在网络恢复后注册模型，不直接调用 set_model 绕过界面。
  await globalThis.__startupRetryRegister();
  const finalize = () => POST(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "finalize-existing", type: "ensure_session", cwd: f.cwd, sessionId: first.sessionId, shadowMindEnabled: false }),
  }));
  const replies = await Promise.all([finalize(), finalize()]);
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.equal(body.kind, "ready");
    assert.equal(body.sessionId, first.sessionId);
    assert.deepEqual(body.model, { provider: "bridge", modelId: "wanted" });
  }
  const targetChanges = f.session.inner.sessionManager.getEntries().filter((entry) => entry.type === "model_change" && entry.provider === "bridge");
  assert.equal(targetChanges.length, 1);
  assert.equal(f.operations.filter((operation) => operation === "create").length, 1);
  assert.equal(f.session.extensionsError, null);
  assert.equal(f.session.inner.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user"), false);
});

for (const available of [true, false]) {
  test(`手动模型优先于旧启动任务：审批后目标${available ? "可用也不覆盖" : "缺失也不写回错误"}`, { timeout: 20_000 }, async (t) => {
    globalThis.__startupRetryProviderAvailable = available;
    const f = await fixture(t);
    await f.restore();
    const entriesBefore = f.session.inner.sessionManager.getEntries().length;
    assert.deepEqual(await f.session.send({ type: "set_model", provider: "local", modelId: "manual" }), { provider: "local", id: "manual" });
    await f.session.send({ type: "set_thinking_level", level: "low" });
    await f.approve();
    await f.session.waitForStartupModelSwitch({ retry: true });
    assert.equal(f.session.inner.model.provider, "local");
    assert.equal(f.session.inner.model.id, "manual");
    assert.equal(f.session.inner.thinkingLevel, "low");
    assert.equal(f.session.extensionsError, null);
    assert.equal(f.events.some((event) => event.type === "extensions_error"), false);
    const newEntries = f.session.inner.sessionManager.getEntries().slice(entriesBefore);
    assert.equal(newEntries.some((entry) => entry.type === "model_change" && entry.provider === "bridge"), false);
    // 只替换最终发送入口以避免外发；模型、审批、磁盘和 wrapper 发送门槛仍执行真实实现。
    const prompt = t.mock.method(f.session.inner, "prompt", async () => {});
    await f.session.send({ type: "prompt", message: "Use the manually selected model" });
    assert.equal(prompt.mock.callCount(), 1);
  });
}

test("仅手动调整强度时仍初始化目标模型，并保留被占位模型限幅前的强度", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.restore();
  assert.equal(f.session.inner.model.id, "standin");
  await f.session.send({ type: "set_thinking_level", level: "low" });
  assert.equal(f.session.inner.thinkingLevel, "off", "占位模型不支持思考，不能把限幅后的 off 当作用户意图");
  await f.approve();
  await f.session.waitForStartupModelSwitch();
  assert.equal(f.session.inner.model.provider, "bridge");
  assert.equal(f.session.inner.model.id, "wanted");
  assert.equal(f.session.inner.thinkingLevel, "low");
});

test("失败的手动选模不取消原启动模型与强度恢复", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.restore();
  await assert.rejects(f.session.send({ type: "set_model", provider: "local", modelId: "missing" }), /Model not found/);
  await f.approve();
  await f.session.waitForStartupModelSwitch();
  assert.equal(f.session.inner.model.provider, "bridge");
  assert.equal(f.session.inner.model.id, "wanted");
  assert.equal(f.session.inner.thinkingLevel, "high");
});

for (const startupFails of [false, true]) {
  test(`启动切模已在执行时手动偏好仍最终生效：旧切换${startupFails ? "失败" : "成功"}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    await f.restore();
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const continueStartup = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const setModel = f.session.inner.setModel.bind(f.session.inner);
    t.mock.method(f.session.inner, "setModel", async (model) => {
      if (model.provider === "bridge") {
        entered();
        await continueStartup;
        if (startupFails) throw new Error("Startup selection fixture failure");
      }
      return setModel(model);
    });
    await f.approve();
    await started;
    const model = f.session.send({ type: "set_model", provider: "local", modelId: "manual" });
    const thinking = f.session.send({ type: "set_thinking_level", level: "low" });
    release();
    await Promise.all([model, thinking]);
    await f.session.waitForStartupModelSwitch({ retry: true });
    assert.equal(f.session.inner.model.provider, "local");
    assert.equal(f.session.inner.model.id, "manual");
    assert.equal(f.session.inner.thinkingLevel, "low");
    assert.equal(f.session.extensionsError, null);
  });
}
