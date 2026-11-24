import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { startRpcSession } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");

for (const phase of ["auth", "pre-commit", "state-write"]) test(`Fast 在 ${phase} 阶段冲突后，磁盘和重开会话仍保留 high`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fast-auth-write-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let wrapper;
  let releaseAuth = () => {};
  t.after(async () => {
    releaseAuth();
    await wrapper?.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { synthetic: {
    baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", apiKey: "synthetic-not-a-key",
    models: [{ id: "b", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(root, "pi-web-model-capabilities.json"), JSON.stringify({ fastModels: ["synthetic/b"] }));
  await writeFile(join(root, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: false } }));
  ({ session: wrapper } = await startRpcSession(`__new__${root}`, "", cwd, {
    toolNames: [], initialModel: { provider: "synthetic", modelId: "b" },
    thinkingLevel: "high", thinkingLevelExplicit: false, fastEnabled: false,
  }));
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  const beforeModel = wrapper.inner.model;
  const file = wrapper.inner.sessionFile;
  const id = wrapper.sessionId;
  // 基线必须在切换之前读取，否则会漏掉 SDK 曾经写入过 low 的污染。
  const before = await readFile(file, "utf8");
  const external = `${JSON.stringify({ type: "custom", id: "outside-during-fast", parentId: wrapper.inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`;
  const blocked = new Promise(resolve => { releaseAuth = resolve; });
  let signalAuth;
  const reached = new Promise(resolve => { signalAuth = resolve; });
  const runtime = wrapper.inner.modelRuntime;
  const originalAuth = runtime.checkAuth;
  let authComplete = false;
  const authMock = t.mock.method(runtime, "checkAuth", async function (...args) {
    signalAuth();
    if (phase === "auth") await blocked;
    const result = await originalAuth.apply(this, args);
    authComplete = true;
    return result;
  });
  let checksAfterAuth = 0;
  const originalFreshness = wrapper.diskFreshness;
  const freshnessMock = t.mock.method(wrapper, "diskFreshness", function () {
    const boundary = phase === "pre-commit" ? 2 : 3;
    if (phase !== "auth" && authComplete && ++checksAfterAuth === boundary) appendFileSync(file, external);
    return originalFreshness.call(this);
  });
  const sdkSetModel = t.mock.method(wrapper.inner, "setModel");
  const fast = wrapper.send({ type: "set_fast_enabled", enabled: true });
  const resultCheck = assert.rejects(fast, error => error.name === "SessionFileConflictError");
  await reached;
  if (phase === "auth") { appendFileSync(file, external); releaseAuth(); }
  await resultCheck;
  assert.strictEqual(wrapper.inner.model, beforeModel);
  assert.equal(wrapper.inner.thinkingLevel, "high");
  assert.equal((await wrapper.send({ type: "get_state" })).fastEnabled, false);
  assert.equal(sdkSetModel.mock.callCount(), 0, "同模型 Fast 不得调用会重新定档的 SDK setModel");
  assert.equal(await readFile(file, "utf8"), before + external, "除了外部新增行，不能留下模型、档位或 Fast 记录");
  authMock.mock.restore();
  freshnessMock.mock.restore();
  sdkSetModel.mock.restore();
  await wrapper.shutdown();
  ({ session: wrapper } = await startRpcSession(id, file, undefined));
  assert.equal(wrapper.inner.thinkingLevel, "high", "重新打开必须仍按原档位恢复");
  assert.equal((await wrapper.send({ type: "get_state" })).fastEnabled, false);
});
