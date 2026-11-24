import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { startRpcSession } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");

for (const fallback of [false, true]) test(fallback ? "SDK 兜底推荐经过 Fast 初始化与扩展绑定后仍为 high" : "已知模型推荐通过构造参数应用，不提前触发扩展选档事件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-startup-fast-thinking-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let wrapper;
  t.after(async () => {
    await wrapper?.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const eventsPath = join(root, "extension-events.log");
  const extensionPath = join(root, "probe-extension.ts");
  await writeFile(extensionPath, `import { appendFileSync } from "node:fs";\nexport default function(pi) {\n pi.on("session_start", () => { appendFileSync(${JSON.stringify(eventsPath)}, "start\\n"); });\n pi.on("thinking_level_select", () => { appendFileSync(${JSON.stringify(eventsPath)}, "thinking\\n"); });\n}\n`);
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { synthetic: {
    baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", apiKey: "synthetic-not-a-key",
    models: [{ id: "b", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(root, "pi-web-model-capabilities.json"), JSON.stringify({ fastModels: ["synthetic/b"] }));
  await writeFile(join(root, "settings.json"), JSON.stringify({
    ...(!fallback ? { defaultProvider: "synthetic", defaultModel: "b", enabledModels: ["synthetic/*"] } : {}),
    defaultThinkingLevel: "low", extensions: [extensionPath], retry: { enabled: false }, compaction: { enabled: false },
  }));
  ({ session: wrapper } = await startRpcSession(`__new__${root}`, "", cwd, {
    toolNames: ["read"], thinkingLevel: "high", thinkingLevelExplicit: false,
    thinkingLevelModel: { provider: "synthetic", modelId: "b" },
    ...(fallback ? { fastEnabled: true } : {}),
  }));
  assert.equal(wrapper.inner.thinkingLevel, "high");
  await wrapper.whenExtensionsBound();
  assert.equal(wrapper.inner.thinkingLevel, "high");
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
  assert.ok(events.includes("start"));
  if (!fallback) assert.equal(events[0], "start", "已知启动档位不应在 session_start 前触发 thinking_level_select");
  if (fallback) {
    await t.test("Fast 鉴权挂起时的手动改档排在其后，确认后不会被 SDK 重置", async () => {
      await wrapper.send({ type: "set_thinking_level", level: "low" });
      let releaseAuth;
      let signalAuth;
      const blocked = new Promise(resolve => { releaseAuth = resolve; });
      const reached = new Promise(resolve => { signalAuth = resolve; });
      const runtime = wrapper.inner.modelRuntime;
      const original = runtime.checkAuth;
      const authMock = t.mock.method(runtime, "checkAuth", async function (...args) {
        signalAuth();
        await blocked;
        return original.apply(this, args);
      });
      const switching = wrapper.send({ type: "set_fast_enabled", enabled: false });
      try {
        await reached;
        let confirmed = false;
        const manual = wrapper.send({ type: "set_thinking_level", level: "high" }).then(() => { confirmed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(confirmed, false, "Fast 仍在鉴权时不能提前确认改档");
        releaseAuth();
        await Promise.all([switching, manual]);
        assert.equal(wrapper.inner.thinkingLevel, "high");
      } finally {
        releaseAuth();
        await switching;
        authMock.mock.restore();
      }
      await wrapper.send({ type: "set_fast_enabled", enabled: true });
      assert.equal(wrapper.inner.thinkingLevel, "high");
    });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_input, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { message: "Local interception", type: "fixture" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    });
    await wrapper.inner.prompt("First request intercepted locally");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, "high");
    assert.equal(requests[0].service_tier, "priority");
    await t.test("Fast 出队时拒绝外部 JSONL 追加，不从旧叶节点写入", async () => {
      let releaseRefresh;
      let signalRefresh;
      const blocked = new Promise(resolve => { releaseRefresh = resolve; });
      const reached = new Promise(resolve => { signalRefresh = resolve; });
      const refreshMock = t.mock.method(wrapper.inner.modelRuntime, "refresh", async () => { signalRefresh(); await blocked; });
      const setModelMock = t.mock.method(wrapper.inner, "setModel");
      const switching = wrapper.send({ type: "set_model", provider: "synthetic", modelId: "b" });
      const rejectedSwitch = assert.rejects(switching, error => error.name === "SessionFileConflictError");
      await reached;
      // Fast 此刻已通过 send 入口的校验，但仍排在刷新之后。
      const fast = wrapper.send({ type: "set_fast_enabled", enabled: false });
      const rejectedFast = assert.rejects(fast, error => error.name === "SessionFileConflictError");
      try {
        await appendFile(wrapper.inner.sessionFile, `${JSON.stringify({ type: "custom", id: "external-writer", parentId: wrapper.inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
        releaseRefresh();
        await Promise.all([rejectedSwitch, rejectedFast]);
        assert.equal(setModelMock.mock.callCount(), 0, "Fast 拒绝后不得调用 SDK 写入模型记录");
      } finally {
        releaseRefresh();
        refreshMock.mock.restore();
        setModelMock.mock.restore();
      }
    });
  }
});
