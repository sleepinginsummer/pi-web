import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { materializeNewSession } = await createJiti(import.meta.url).import("../lib/new-session-materialization-client.ts");
const { noticeReducer } = await createJiti(import.meta.url).import("../lib/notice-state.ts");
const { captureDraftTransfer, setDraft, getDraft, clearDraft } = await createJiti(import.meta.url).import("../lib/draft-store.ts");

// 与已有运行态回归一样，直接执行生产回调，替换网络和 React 容器，不复制握手逻辑。
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
function findNode(name) {
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === name) return node;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, visit);
  }
  const node = visit(ast);
  assert.ok(node, `找不到生产回调 ${name}`);
  return node;
}
function compile(name, context) {
  const js = ts.transpileModule(`(${findNode(name).getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Script(js).runInContext(context);
}
function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = [];
  const notices = [];
  const received = [];
  let noticeState = { visible: [], pending: [] };
  let noticeSequence = 0;
  const sandbox = {
    STREAM_CLOSED: 2, STREAM_OPEN: 1, EVENT_STREAM_CONNECT_TIMEOUT_MS: 15000,
    setTimeout, clearTimeout, AbortController, console,
    eventSourceRef: { current: null }, eventStreamConnectionRef: { current: null },
    eventStreamStartupFailureRef: { current: null }, sessionIdRef: { current: "a" },
    eventStreamRetryNoticeRef: { current: null },
    agentRunningRef: { current: true }, handleAgentEventRef: { current: event => received.push(event) },
    beginRuntimeRead() {}, applyRuntimeSnapshot() {},
    fetchRuntimeState: async () => ({ state: {} }), sendAgentCommand: async () => ({}),
    createNoticeId: () => `notice-${++noticeSequence}`,
    dispatchNotice(action) {
      if (action.type === "add") notices.push(action.notice);
      noticeState = noticeReducer(noticeState, action);
    },
    translateRef: { current: () => "调整回放预算后，重新打开会话重试。" },
    promptRequestStarted: false, sentSessionId: null, fromStash: false, firstPromptRequestStarted: false,
    AgentCommandError: class extends Error {}, isPromptRejectedError: () => false, setPromptMissingCwd() {},
    optimisticUserMessageKeyRef: { current: null }, isNavigationActive: () => true, navigationKey: "a",
    setSubmissionError() {}, setAgentRunning() {}, setAgentPhase() {}, resetStreamDeltas() {}, dispatch() {},
    createStreamSource(url) {
      const source = { url, readyState: 1, onmessage: null, onerror: null,
        close() { this.readyState = 2; },
        emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); },
      };
      sources.push(source);
      return source;
    },
  };
  const context = createContext(sandbox);
  for (const name of ["EventStreamConnectionError", "closeEvents", "addNotice", "connectEvents", "ensureEventsConnected"]) sandbox[name] = compile(name, context);
  const catchBody = findNode("handleSend").body.statements.find(ts.isTryStatement).catchClause.block;
  sandbox.sendFailure = new Script(ts.transpileModule(`(function(e) ${catchBody.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText).runInContext(context);
  t.after(() => sandbox.closeEvents());
  return { ...sandbox, context, sources, notices, received, noticeState: () => noticeState };
}

test("卸载关闭 SSE 会立即结束建连等待", async t => {
  const env = setup(t);
  const pending = env.ensureEventsConnected("a").catch(error => error);
  env.closeEvents();
  const error = await pending;
  assert.equal(error.status, "closed");
  assert.equal(env.sources[0].readyState, 2);
});

for (const fromStash of [false, true]) for (const navigateAway of [false, true]) test(`${fromStash ? "暂存库" : "普通"}首发等待 SSE 时${navigateAway ? "切走仍后台提交" : "当前页真实错误仍拒绝"}`, async t => {
  const env = setup(t);
  const events = [];
  const submitted = [];
  const background = [];
  const sendTry = findNode("handleSend").body.statements.find(ts.isTryStatement);
  const staged = sendTry.tryBlock.statements.find(node => ts.isIfStatement(node) && node.expression.getText(ast).includes('pendingControlKind === "staged"'));
  assert.ok(staged);
  const original = { value: "原草稿", images: [], textAttachment: "原附件" };
  setDraft("new:/a", original);
  clearDraft("a");
  const capturedTransfer = captureDraftTransfer("new:/a");
  t.after(() => { clearDraft("new:/a"); clearDraft("a"); });
  Object.assign(env.context, {
    newSessionCwd: "/a", message: "first prompt", piImages: undefined, displayModel: null,
    fromStash, capturedTransfer,
    currentNewSessionSettings: () => ({ model: null, thinkingLevel: null, shadowMindEnabled: false, thinkingLevelExplicit: false }),
    currentNewSessionToolNames: () => ["read"], setPendingModel() {}, fastEnabled: false, displayModelFastAvailable: false,
    createNewSessionRuntime: async () => "a", onPendingNewSessionEvent: (_cwd, event) => events.push(event),
    submitNewSessionFirstPrompt: async (request) => submitted.push(request),
    onSessionCreatedInBackground: (session) => background.push(session),
    promoteNewSession() { assert.fail("迟到首发不能提升当前页会话"); },
  });
  const send = new Script(ts.transpileModule(`(async function() ${staged.thenStatement.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(env.context);
  const waiting = send();
  await settle();
  assert.equal(env.sources.length, 1);
  if (navigateAway) {
    env.context.isNavigationActive = () => false;
    env.closeEvents();
    assert.equal(await waiting, true);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].sessionId, "a");
    assert.equal(background.length, 1);
    assert.equal(events.some(event => event.type === "POST_START_FAIL"), false);
    if (fromStash) {
      assert.deepEqual(getDraft("a"), original);
      assert.equal(getDraft("new:/a"), null);
    }
  } else {
    const rejection = assert.rejects(waiting, error => error.status === "startup_error");
    env.sources[0].emit({ type: "startup_error", errorMessage: "真实建连失败" });
    await rejection;
    assert.equal(submitted.length, 0);
    assert.equal(events.at(-1).type, "POST_START_FAIL");
  }
});

test("迟到的暂存会话提升走后台，不清空共享 ref 指向的 B 草稿", t => {
  const env = setup(t);
  const background = [];
  const foreground = [];
  let cleared = 0;
  Object.assign(env.context, {
    isNew: true, newSessionCwd: "/a", newSessionPromotedRef: { current: false },
    isNavigationActive: () => false,
    opts: { chatInputRef: { current: { clearAcceptedPrompt() { cleared += 1; } } } },
    onSessionCreated: (session) => foreground.push(session),
    onSessionCreatedInBackground: (session) => background.push(session),
  });
  compile("promoteNewSession", env.context)(1, "accepted prompt");
  assert.equal(cleared, 0);
  assert.equal(foreground.length, 0);
  assert.equal(background.length, 1);
  assert.equal(background[0].id, "a");
});

for (const changed of [false, true]) test(`暂存库后台首发迁移草稿，源${changed ? "已更新则保留" : "未变则清理"}`, t => {
  const env = setup(t);
  const sourceKey = "new:/a";
  const original = { value: "原输入", images: [{ data: "original", mimeType: "image/png" }], textAttachment: "原附件" };
  setDraft(sourceKey, original);
  clearDraft("a");
  t.after(() => { clearDraft(sourceKey); clearDraft("a"); });
  const transfer = captureDraftTransfer(sourceKey);
  if (changed) setDraft(sourceKey, { value: "后来写入", images: [], textAttachment: "新附件" });
  Object.assign(env.context, {
    isNew: true, newSessionCwd: "/a", newSessionPromotedRef: { current: false }, isNavigationActive: () => false,
    opts: { chatInputRef: { current: { clearAcceptedPrompt() { assert.fail("不能清空 B 的输入框"); } } } },
    onSessionCreated() { assert.fail("不能切回 A"); }, onSessionCreatedInBackground() {}, captureDraftTransfer,
  });
  compile("promoteNewSession", env.context)(1, "暂存消息", true, transfer);
  assert.deepEqual(getDraft("a"), original);
  if (changed) assert.equal(getDraft(sourceKey).value, "后来写入");
  else assert.equal(getDraft(sourceKey), null);
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const failure = { type: "startup_error", code: "sse_replay_budget_exceeded", retryable: false, errorMessage: "回放 70 KiB 超过 64 KiB" };

test("页面立即结束启动失败等待并显示服务端详情", async t => {
  const env = setup(t);
  let rejected;
  const waiting = env.ensureEventsConnected("a").catch(error => { rejected = error; });
  env.sources[0].emit(failure);
  await settle();
  assert.equal(rejected?.status, "startup_error", "不能继续等到 15 秒超时");
  assert.equal(rejected.message, failure.errorMessage);
  assert.ok(env.notices.some(notice => notice.type === "error" && notice.message.includes(failure.errorMessage)));
  assert.equal(env.notices[0].expanded, true, "超限详情保留到用户关闭，不自动消失");
  assert.equal(env.sources[0].readyState, 2);
  await waiting;
});

test("超限后被动连接及发送失败清理都不会再次建连", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  env.sources[0].emit(failure);
  await settle();
  assert.equal(env.sources[0].readyState, 2, "启动失败应立即关闭本次连接");
  assert.equal((await first).status, "startup_error");
  env.sources[0].onerror?.({});
  t.mock.timers.tick(60000);
  env.closeEvents();
  assert.equal((await env.connectEvents("a")).status, "startup_error");
  assert.equal(env.sources.length, 1);
  assert.equal(env.notices.length, 1);
});

test("HTTP 已打开但没有 connected 时，超时不能当作就绪", async t => {
  const env = setup(t);
  let outcome;
  const waiting = env.ensureEventsConnected("a").then(() => { outcome = "ready"; }, error => { outcome = error.status; });
  t.mock.timers.tick(15000);
  await settle();
  assert.equal(outcome, "timeout");
  await waiting;
});

test("切换会话后可以重新连接，不继承先前的超限失败", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  env.sources[0].emit(failure);
  await settle();
  assert.equal(env.sources[0].readyState, 2, "启动失败应立即关闭本次连接");
  assert.equal((await first).status, "startup_error");
  env.sessionIdRef.current = "b";
  const second = env.connectEvents("b");
  env.sources.at(-1).emit({ type: "connected" });
  assert.equal((await second).status, "connected");
  env.closeEvents();
  env.sessionIdRef.current = "a";
  const third = env.connectEvents("a");
  env.sources.at(-1).emit({ type: "connected" });
  assert.equal((await third).status, "connected");
  assert.equal(env.sources.length, 3);
});


for (const retryable of [undefined, true]) {
  test(`可恢复启动错误保留同一订阅，后续 connected 恢复就绪：${retryable}`, async t => {
    const env = setup(t);
    const waiting = env.ensureEventsConnected("a").catch(error => error);
    const source = env.sources[0];
    source.emit({ type: "startup_error", errorMessage: "临时启动失败", ...(retryable === undefined ? {} : { retryable }) });
    const error = await waiting;
    assert.equal(error.status, "startup_error");
    assert.equal(error.message, "临时启动失败");
    assert.equal(env.notices[0].message, "临时启动失败");
    assert.equal(source.readyState, 1, "不能关闭仍可重连的底层订阅");
    source.readyState = 0;
    source.onerror?.({});
    const pending = env.connectEvents("a");
    assert.equal(env.sources.length, 1, "退避期间复用订阅，不重新建连");
    await pending;
    source.emit({ type: "connected" });
    source.emit({ type: "extension_ui_request", id: "recovered", method: "select" });
    await env.ensureEventsConnected("a");
    assert.equal(env.sources.length, 1);
    assert.deepEqual(env.received.map(event => event.type), ["connected", "extension_ui_request"]);
  });
}

test("发送等待失败清理保留可恢复订阅，之后仍收到 connected", async t => {
  const env = setup(t);
  const waiting = env.ensureEventsConnected("a").catch(error => error);
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时不可用" });
  const error = await waiting;
  assert.equal(env.sendFailure(error), false);
  assert.equal(env.eventSourceRef.current, source);
  assert.equal(source.readyState, 1);
  source.emit({ type: "connected" });
  await env.ensureEventsConnected("a");
  assert.equal(env.sources.length, 1);
});

test("恢复先于发送失败收尾时，收尾不能关闭已经就绪的连接", async t => {
  const env = setup(t);
  const waiting = env.ensureEventsConnected("a").catch(error => error);
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时不可用" });
  source.emit({ type: "connected" });
  const error = await waiting;
  env.sendFailure(error);
  assert.equal(source.readyState, 1);
  assert.equal(env.eventSourceRef.current, source);
  await env.ensureEventsConnected("a");
});

test("同一订阅连续启动失败更新原因，恢复后的普通断流仍可重连", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "第一次失败" });
  await first;
  source.emit({ type: "startup_error", errorMessage: "第二次失败" });
  assert.equal(source.readyState, 1, "连续的可恢复错误不能终止订阅");
  assert.equal((await env.connectEvents("a")).errorMessage, "第二次失败");
  source.emit({ type: "connected" });
  await env.ensureEventsConnected("a");
  source.readyState = 2;
  source.onerror?.({});
  t.mock.timers.tick(1000);
  assert.equal(env.sources.length, 2, "恢复后不能保留启动失败的错误抑制状态");
});


test("新会话初始化的字符串错误结果仍保留可恢复建连异常，恢复后发送收尾不关流", async t => {
  const env = setup(t);
  const statements = findNode("ensureNewSession").body.statements;
  const attempt = statements.find(ts.isTryStatement);
  const failed = statements.find(node => ts.isIfStatement(node) && node.expression.getText(ast) === 'result.kind === "materialization-failed"');
  const context = createContext({ ...env, materializeNewSession,
    sessionRequest: { operation: "finalize-existing", sessionId: "a" }, newSessionCwd: "/project",
    currentNewSessionToolNames: () => [], requestedShadowMindEnabled: false, selectedModel: null,
    selectedThinkingLevel: null, fastEnabled: false, displayModelFastAvailable: false, onPendingNewSessionEvent() {},
    // 被提取的创建片段读取已解析草稿参数；此用例只测建连恢复，使用自动档位的空快照。
    latest: { thinkingLevelExplicit: false, thinkingLevelModel: undefined },
  });
  const materialize = new Script(ts.transpileModule(`(async function() {
    let result; let streamConnectionError;
    ${attempt.getText(ast)}
    const realId = result.sessionId;
    ${failed.getText(ast)}
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context);
  const waiting = materialize().catch(error => error);
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时不可用" });
  source.emit({ type: "connected" });
  const error = await waiting;
  assert.equal(error.status, "startup_error");
  assert.equal(error.retryable, true);
  env.sendFailure(error);
  assert.equal(env.eventSourceRef.current, source);
  assert.equal(source.readyState, 1);
  await env.ensureEventsConnected("a");
});


test("恢复期间相同启动错误只提示一次，详情变化更新已展开通知", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  await first;
  const id = env.noticeState().visible[0].id;
  env.dispatchNotice({ type: "set_expanded", id, expanded: true, now: 1 });
  const before = env.noticeState();
  for (let index = 0; index < 30; index++) source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  assert.equal(env.noticeState(), before, "相同错误不派发新提示，也不重置可见时间");
  assert.equal(env.notices.length, 1);
  source.emit({ type: "startup_error", errorMessage: "原因已变化" });
  assert.equal(env.noticeState().visible.length, 1);
  assert.equal(env.noticeState().visible[0].id, id);
  assert.equal(env.noticeState().visible[0].message, "原因已变化");
  assert.equal(env.noticeState().visible[0].expanded, true);
  assert.equal(env.noticeState().pending.length, 0);
});

test("五条通知都展开时，自动重试不积压副本，也不延后其它通知", async t => {
  const env = setup(t);
  for (let index = 0; index < 5; index++) env.addNotice({ id: `blocking-${index}`, type: "info", message: "已展开", expanded: true });
  const first = env.connectEvents("a");
  const source = env.sources[0];
  for (let index = 0; index < 30; index++) source.emit({ type: "startup_error", errorMessage: "同一个原因" });
  await first;
  const id = env.noticeState().pending[0].id;
  env.addNotice({ id: "other", type: "warning", message: "其它通知" });
  source.emit({ type: "startup_error", errorMessage: "最新原因" });
  assert.equal(env.noticeState().visible.length, 5);
  assert.deepEqual(env.noticeState().pending.map(notice => notice.id), [id, "other"]);
  assert.equal(env.noticeState().pending[0].message, "最新原因");
});

test("connected 重置通知去重，下一轮相同错误仍会提示", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  await first;
  const firstId = env.noticeState().visible[0].id;
  source.emit({ type: "connected" });
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  assert.equal(env.noticeState().visible.length, 2);
  assert.notEqual(env.noticeState().visible[1].id, firstId);
});

test("同一会话恢复前来源重建仍复用本轮通知", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  env.sources[0].emit({ type: "startup_error", errorMessage: "暂时失败" });
  await first;
  const id = env.noticeState().visible[0].id;
  env.sources[0].readyState = 2;
  env.sources[0].onerror({});
  t.mock.timers.tick(1000);
  assert.equal(env.sources.length, 2);
  env.sources[1].emit({ type: "startup_error", errorMessage: "暂时失败" });
  assert.equal(env.notices.length, 1);
  env.sources[1].emit({ type: "startup_error", errorMessage: "新的原因" });
  assert.equal(env.noticeState().visible.length, 1);
  assert.equal(env.noticeState().visible[0].id, id);
  assert.equal(env.noticeState().visible[0].message, "新的原因");
});


test("本轮提示过期后相同错误不重新入队，新详情仍能显示", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  await first;
  const id = env.noticeState().visible[0].id;
  env.dispatchNotice({ type: "remove", id, now: Date.now() });
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  assert.equal(env.noticeState().visible.length, 0);
  assert.equal(env.notices.length, 1);
  source.emit({ type: "startup_error", errorMessage: "新详情" });
  assert.equal(env.noticeState().visible[0].id, id);
  assert.equal(env.noticeState().visible[0].message, "新详情");
});


test("仅首尾空白变化不重新显示提示，连接结果仍保留原始错误", async t => {
  const env = setup(t);
  const first = env.connectEvents("a");
  const source = env.sources[0];
  source.emit({ type: "startup_error", errorMessage: "暂时失败" });
  await first;
  const id = env.noticeState().visible[0].id;
  env.dispatchNotice({ type: "remove", id, now: Date.now() });
  const raw = " \t暂时失败\r\n";
  source.emit({ type: "startup_error", errorMessage: raw });
  assert.equal((await env.connectEvents("a")).errorMessage, raw);
  assert.equal(env.noticeState().visible.length, 0);
  assert.equal(env.notices.length, 1);
  const error = await env.ensureEventsConnected("a").catch(error => error);
  assert.equal(error.message, raw);
  source.emit({ type: "startup_error", errorMessage: "  新详情\n" });
  assert.equal(env.noticeState().visible[0].id, id);
  assert.equal(env.noticeState().visible[0].message, "新详情");
});

test("旧退场计时器在更新提交前触发，也不能删除最新通知", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = noticeReducer({ visible: [], pending: [] }, { type: "add", notice: { id: "timer", message: "旧详情", type: "error" }, now: 0 });
  current = noticeReducer(current, { type: "mark_expired", now: 5000 });
  function findEffect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0].getText(ast).includes("NOTICE_EXIT_ANIMATION_MS")) return node.arguments[0];
    return ts.forEachChild(node, findEffect);
  }
  const context = createContext({ noticeState: current, setTimeout, clearTimeout, Date,
    NOTICE_EXIT_ANIMATION_MS: 180, NOTICE_VISIBLE_MS: 5000,
    dispatchNotice(action) { current = noticeReducer(current, action); },
  });
  const effect = new Script(ts.transpileModule(`(${findEffect(ast).getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context);
  const cleanup = effect();
  // 模拟 React 还未 commit，因此旧 effect 尚未 cleanup，计时器仍能派发动作。
  current = noticeReducer(current, { type: "add", notice: { id: "timer", message: "最新详情", type: "error" }, now: 5100 });
  t.mock.timers.tick(180);
  assert.equal(current.visible.length, 1);
  assert.equal(current.visible[0].message, "最新详情");
  assert.equal(current.visible[0].exiting, false);
  cleanup();
});
