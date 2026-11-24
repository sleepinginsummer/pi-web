import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
function setup() {
  const writes = [];
  const requests = [];
  const context = createContext({
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "a" },
    promptRunIdRef: { current: 1 }, contextUsageRequestIdRef: { current: 0 }, contextUsageAppliedIdRef: { current: 0 },
    agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true }, rpcPromptPendingRef: { current: true },
    setContextUsage: (value) => writes.push(value),
    reconcileRequestGenerationRef: { current: 0 }, extensionDialogRef: { current: null }, askQuestionnaireRef: { current: null },
    setAgentRunning() {}, setSystemPrompt() {}, applyShadowRuntimeState() {},
    modelSelectionActions: { setThinkingLevel() {} }, setFastEnabled() {}, setRuntimeFastAvailable() {},
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (widgets) => widgets,
    fetch: (url) => { const request = Promise.withResolvers(); requests.push({ ...request, url }); return request.promise; },
    agentStatusUrl: (sid) => `/api/agent/${sid}?systemPrompt=0`, setLiveTotalActiveMs() {},
    syncLiveModel() {}, setIsCompacting() {}, setAutoCompactionEnabled() {}, setQueuedMessages() {},
    // 队列显示走唯一写入口（界面状态 + 错误页读的镜像）。
    updateQueuedMessages() {},
    // applyRuntimeState 也把正在跑的扩展命令写回顶栏提示。
    setRunningCommands() {},
    // applyRuntimeState 也会把扩展绑定状态交给唯一状态机（新会话等待态）。
    newSessionCwd: null, onPendingNewSessionEvent() {},
    projectExtensionBinding: () => "bound",
    normalizeQueuedMessages: (value) => value, finishPromptWithoutStream: () => { throw new Error("busy run settled"); },
    // 运行态快照按读取坐标投影：迟到的不覆盖实时队列、压缩与思考强度。
    runtimeReadSeqRef: { current: 0 }, queueStateGenerationRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    compactionEpochRef: { current: 0 }, lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 }, lastAppliedThinkingSeqRef: { current: 0 },
    runtimeThinkingLevelSessionRef: { current: null }, thinkingChoiceRevisionRef: { current: 0 },
    runtimeBusySnapshotRef: { current: null },
  });
  context.applyContextUsage = callback("applyContextUsage").runInContext(context);
  context.applyRuntimeState = callback("applyRuntimeState").runInContext(context);
  context.beginRuntimeRead = callback("beginRuntimeRead").runInContext(context);
  context.applyRuntimeSnapshot = callback("applyRuntimeSnapshot").runInContext(context);
  context.readAgentSnapshot = callback("readAgentSnapshot").runInContext(context);
  context.applyAgentSnapshot = callback("applyAgentSnapshot").runInContext(context);
  context.refreshContextUsage = callback("refreshContextUsage").runInContext(context);
  context.reconcileAgentState = callback("reconcileAgentState").runInContext(context);
  const reply = (index, usage, busy = true) => requests[index].resolve(Response.json({ alive: true, busy, state: { contextUsage: usage, isStreaming: busy, isPromptRunning: busy } }));
  return { context, writes, requests, reply };
}
const usage = (tokens) => ({ percent: tokens / 100, contextWindow: 10_000, tokens });

test("a busy reconciliation refreshes context usage without settling the run", async () => {
  const state = setup();
  const pending = state.context.reconcileAgentState("a");
  state.reply(0, usage(100));
  await pending;
  assert.deepEqual(state.writes, [usage(100)]);
  assert.equal(state.context.agentRunningRef.current, true);
});

test("a newer assistant usage read wins over a delayed poll", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.reply(1, usage(200)); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(200)]);
});

test("a failed newer read does not discard an older poll's usage", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.requests[1].resolve(new Response("Unavailable", { status: 503 })); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(100)]);
});

test("usage replies from an old run, another session or an unmounted hook are ignored", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.contextUsageAppliedIdRef.current = ctx.contextUsageRequestIdRef.current; },
  ]) {
    const state = setup();
    const pending = state.context.refreshContextUsage("a");
    invalidate(state.context); state.reply(0, usage(100)); await pending;
    assert.deepEqual(state.writes, []);
  }
});

test("failed reads preserve usage and a subsequent read can recover", async () => {
  const state = setup();
  const failed = state.context.refreshContextUsage("a");
  state.requests[0].resolve(new Response("Unavailable", { status: 503 })); await failed;
  const broken = state.context.refreshContextUsage("a");
  state.requests[1].reject(new TypeError("offline")); await broken;
  assert.deepEqual(state.writes, []);
  const recovered = state.context.refreshContextUsage("a");
  state.reply(2, null); await recovered;
  assert.deepEqual(state.writes, [null]);
});

test("only completed assistant messages trigger an immediate usage read", () => {
  const messageEnd = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"message_end"');
  const script = new Script(ts.transpileModule(`(() => { switch(event.type) { ${messageEnd.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const role of ["assistant", "toolResult", "user", "system"]) {
    const reads = [];
    script.runInNewContext({
      event: { type: "message_end", message: { role, content: [] } },
      agentRunningRef: { current: true }, sessionIdRef: { current: "a" }, optimisticUserMessageKeyRef: { current: null },
      isSystemMessageEvent: (event) => event.message.role === "system",
      flushStreamDeltas() {}, isNew: false, completedDetachedSubagentIds: () => [],
      pendingDetachedSubagentIdsRef: { current: new Set() }, normalizeAssistantMessage: (message) => message,
      normalizeToolCalls: (message) => message, userMessageKey: () => "user", setMessages() {}, dispatch() {}, setAgentPhase() {},
      setToolClocks() {}, withoutToolClock: (clocks) => clocks,
      refreshContextUsage: (sid) => reads.push(sid),
    });
    assert.deepEqual(reads, role === "assistant" ? ["a"] : []);
  }
});

test("each event stream connection reads usage, since connecting resumes an idle-reaped session", () => {
  const connected = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"connected"');
  const script = new Script(ts.transpileModule(`(() => { switch(event.type) { ${connected.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const [sid, isStreaming, known] of [["a", false, false], ["a", true, false], [null, false, false], ["a", false, true]]) {
    const reads = [];
    const toolReads = [];
    script.runInNewContext({
      event: { type: "connected", sessionId: sid ?? "pending", isStreaming },
      sessionIdRef: { current: sid }, sdkAgentActiveRef: { current: false }, agentRunningRef: { current: false },
      dispatch() {}, cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {},
      setToolClocks() {}, endedToolClocks: (value) => value,
      // fork 的 connected 分支还会同步扩展弹窗并采用运行中的会话。
      setExtensionDialog() {}, setExtensionCustomUi() {}, extensionDialogRef: { current: null }, enterMainRun() {},
      refreshContextUsage: (id) => reads.push(id),
      toolSelectionKnown: known, loadTools: (id) => toolReads.push(id),
    });
    assert.deepEqual(reads, sid ? [sid] : []);
    assert.deepEqual(toolReads, sid && !known ? [sid] : [], "只补读未知预设，已初始化的新会话不重复查询");
  }
});
