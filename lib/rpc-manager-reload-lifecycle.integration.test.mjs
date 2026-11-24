import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { startRpcSession } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
const EXTENSION = `export default function (pi) {
  const state = globalThis.__piWebNativeReloadCase;
  if (state.kind === "append") {
    pi.on("session_start", async (event) => {
      if (event.reason !== "reload") return;
      if (state.phase === "hook") { state.entered(); await state.gate; }
      state.attempted += 1;
      pi.appendEntry("native-reload-write", { source: "session_start" });
      state.written += 1;
    });
  } else if (state.kind === "compact") {
    pi.on("session_before_compact", async (event) => {
      state.entered();
      await state.gate;
      return { compaction: { summary: "native background summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    });
    pi.on("session_start", (event, ctx) => {
      if (event.reason !== "reload") return;
      ctx.compact({ onComplete: result => { state.result = result; state.done(); }, onError: error => { state.error = error; state.done(); } });
    });
  } else {
    const mount = (ctx, phase) => {
      ctx.ui.setStatus("native-status", phase);
      ctx.ui.setWidget("native-array", [phase]);
      ctx.ui.setWidget("native-factory-" + phase, (tui) => {
        state.created += 1;
        state.tuis.push(tui);
        return { render: () => [phase], dispose: () => { state.disposed += 1; } };
      });
    };
    pi.on("session_start", (_event, ctx) => mount(ctx, "start"));
    pi.on("session_shutdown", (event, ctx) => {
      if (event.reason === "reload") { state.shutdowns += 1; mount(ctx, "shutdown"); }
    });
  }
}`;

async function fixture(t, state) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-reload-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd);
  const extension = join(agentDir, "extensions", "native-hooks.ts");
  await writeFile(extension, EXTENSION);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: {
    baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", apiKey: "synthetic-not-a-key",
    models: [{ id: "primary", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 16 } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piWebNativeReloadCase = state;
  let wrapper;
  t.after(async () => {
    state.release?.();
    await wrapper?.shutdown();
    delete globalThis.__piWebNativeReloadCase;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  ({ session: wrapper } = await startRpcSession(`__new__${root}`, "", cwd, {
    toolNames: ["read"], initialModel: { provider: "synthetic", modelId: "primary" },
    thinkingLevel: "high", thinkingLevelExplicit: false,
  }));
  await wrapper.waitUntilReady();
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "persist seed", timestamp: Date.now() });
  return { wrapper, extension };
}

for (const phase of ["resource", "hook"]) test(`真实 SDK ${phase} 等待期间外部追加后，不得沿旧叶节点写入`, async (t) => {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const state = { kind: "append", phase, entered, gate, release, attempted: 0, written: 0 };
  const { wrapper } = await fixture(t, state);
  const { inner } = wrapper;
  const nativeReload = inner.reload;
  const originalAppend = inner.sessionManager.appendCustomEntry;
  const originalEntries = inner.sessionManager.getEntries();
  if (phase === "resource") {
    const loader = inner.resourceLoader;
    const reload = loader.reload;
    // 只挂起真实资源加载；AgentSession.reload、钩子派发和 pi.appendEntry 均保持原实现。
    t.mock.method(loader, "reload", async function (...args) {
      entered(); await gate;
      return reload.apply(this, args);
    });
  }
  const reloading = wrapper.send({ type: "reload" });
  await reached;
  await appendFile(inner.sessionFile, `${JSON.stringify({ type: "custom", id: "outside-native-reload", parentId: inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
  const persisted = await readFile(inner.sessionFile, "utf8");
  release();
  const [result] = await Promise.allSettled([reloading]);
  assert.notEqual(result.status, "fulfilled");
  assert.equal(result.reason.name, "SessionFileConflictError", "SDK 捕获钩子异常后，重载调用方仍应收到冲突");
  assert.strictEqual(inner.reload, nativeReload);
  assert.strictEqual(inner.sessionManager.appendCustomEntry, originalAppend);
  assert.equal(state.written, 0);
  assert.deepEqual(inner.sessionManager.getEntries(), originalEntries);
  assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
});

for (const entry of ["rpc", "command"]) test(`真实 SDK 旧扩展 shutdown 留下的组件由 ${entry} 重载在启动前清理`, async (t) => {
  const state = { kind: "widgets", created: 0, disposed: 0, shutdowns: 0, tuis: [] };
  const { wrapper, extension } = await fixture(t, state);
  const nativeReload = wrapper.inner.reload;
  const originalAppend = wrapper.inner.sessionManager.appendCustomEntry;
  assert.equal(state.created, 1, "初始 session_start 已真实挂载组件");
  const run = () => entry === "rpc" ? wrapper.send({ type: "reload" }) : wrapper.createExtensionCommandContextActions().reload();
  await run();
  await unlink(extension);
  await run();
  assert.strictEqual(wrapper.inner.reload, nativeReload);
  assert.strictEqual(wrapper.inner.sessionManager.appendCustomEntry, originalAppend);
  assert.equal(state.shutdowns, 2);
  assert.equal(state.created, 4);
  assert.equal(state.disposed, state.created, "包括已移除扩展的 shutdown 新挂载的组件也必须释放");
  const snapshot = await wrapper.send({ type: "get_state" });
  assert.deepEqual(snapshot.extensionStatuses, []);
  assert.deepEqual(snapshot.extensionWidgets, []);
  state.tuis.forEach(tui => tui.requestRender());
  assert.deepEqual((await wrapper.send({ type: "get_state" })).extensionWidgets, []);
});

for (const external of [false, true]) test(`真实 ctx.compact 在重载返回后提交，外部追加=${external}`, async t => {
  let entered, release, done;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const finished = new Promise(resolve => { done = resolve; });
  const state = { kind: "compact", entered, gate, release, done };
  const { wrapper } = await fixture(t, state);
  const { inner } = wrapper;
  inner.sessionManager.appendMessage({ role: "user", content: "history ".repeat(2048), timestamp: Date.now() });
  inner.sessionManager.appendMessage({ role: "user", content: "latest", timestamp: Date.now() });
  const nativeReload = inner.reload, nativeCompact = inner.compact;
  await wrapper.send({ type: "reload" });
  await Promise.race([reached, finished.then(() => { throw new Error(`压缩未进入等待钩子：${state.error}`); })]);
  assert.equal(state.result, undefined, "SDK 重载已返回，后台压缩仍在等待");
  const entries = inner.sessionManager.getEntries();
  if (external) await appendFile(inner.sessionFile, `${JSON.stringify({ type: "custom", id: "outside-background-compact", parentId: inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
  const persisted = await readFile(inner.sessionFile, "utf8");
  release();
  await finished;
  assert.strictEqual(inner.reload, nativeReload);
  assert.strictEqual(inner.compact, nativeCompact);
  if (external) {
    assert.equal(state.error?.name, "SessionFileConflictError", "冲突应经 SDK 原有 onError 返回");
    assert.equal(state.result, undefined);
    assert.deepEqual(inner.sessionManager.getEntries(), entries);
    assert.equal(await readFile(inner.sessionFile, "utf8"), persisted);
  } else {
    assert.equal(state.error, undefined);
    assert.equal(state.result.summary, "native background summary");
    assert.equal(inner.sessionManager.getEntries().at(-1).type, "compaction");
  }
});

for (const entry of ["rpc", "command"]) for (const phase of ["conflict", "resource-error", "before-sdk"]) test(`真实 ${entry} 重载失败清理：${phase}`, async t => {
  const state = { kind: "widgets", created: 0, disposed: 0, shutdowns: 0, tuis: [] };
  const { wrapper } = await fixture(t, state);
  const { inner } = wrapper;
  const nativeReload = inner.reload;
  const events = [];
  t.after(wrapper.onEvent(event => events.push(event)));
  const loader = inner.resourceLoader, reload = loader.reload;
  const resourceError = new Error("模拟真实资源加载失败");
  const appendOutside = () => appendFile(inner.sessionFile, `${JSON.stringify({ type: "custom", id: "outside-failed-reload", parentId: inner.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "fixture", data: {} })}\n`);
  if (phase === "before-sdk") await appendOutside();
  else t.mock.method(loader, "reload", async function (...args) {
    if (phase === "resource-error") throw resourceError;
    await reload.apply(this, args);
    await appendOutside();
  });
  const run = () => entry === "rpc" ? wrapper.send({ type: "reload" }) : wrapper.createExtensionCommandContextActions().reload();
  await assert.rejects(run(), error => phase === "resource-error" ? error === resourceError : error.name === "SessionFileConflictError");
  assert.strictEqual(inner.reload, nativeReload);
  const snapshot = await wrapper.send({ type: "get_state" });
  if (phase === "before-sdk") {
    assert.equal(state.shutdowns, 0);
    assert.equal(state.disposed, 0, "旧 runner 尚未失效，必须保留仍可用的组件");
    assert.equal(snapshot.extensionStatuses.length, 1);
    assert.equal(snapshot.extensionWidgets.length, 2);
    assert.deepEqual(events.filter(event => event.type === "extension_ui_request" && ["setStatus", "setWidget"].includes(event.method)), [], "SDK 未开始时不应向现有客户端删除有效组件");
  } else {
    assert.equal(state.shutdowns, 1);
    assert.equal(state.created, 2);
    assert.equal(state.disposed, state.created, "旧 runner 已失效，关闭钩子留下的组件也必须释放");
    assert.deepEqual(snapshot.extensionStatuses, []);
    assert.deepEqual(snapshot.extensionWidgets, []);
    // 客户端只消费订阅事件，不依赖 /reload 成功或再次获取快照。
    const uiEvents = events.filter(event => event.type === "extension_ui_request");
    assert.ok(uiEvents.some(event => event.method === "setStatus" && event.statusText === "shutdown"));
    assert.ok(uiEvents.some(event => event.method === "setWidget" && event.widgetKey === "native-array" && event.widgetLines?.[0] === "shutdown"));
    const statusEvents = uiEvents.filter(event => event.method === "setStatus" && event.statusKey === "native-status");
    assert.equal(statusEvents.at(-1).statusText, undefined, "已订阅客户端须收到状态删除事件");
    for (const key of ["native-array", "native-factory-start", "native-factory-shutdown"]) {
      const widgetEvents = uiEvents.filter(event => event.method === "setWidget" && event.widgetKey === key);
      assert.ok(widgetEvents.length > 0, `${key} 须广播删除`);
      assert.equal(widgetEvents.at(-1).widgetLines, undefined, `${key} 的最后一条订阅事件须删除组件`);
    }
    state.tuis.forEach(tui => tui.requestRender());
    assert.deepEqual((await wrapper.send({ type: "get_state" })).extensionWidgets, []);
  }
});
