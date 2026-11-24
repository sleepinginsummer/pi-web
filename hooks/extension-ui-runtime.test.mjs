import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { mergeExtensionUiSnapshot } = await createJiti(import.meta.url).import("../lib/extension-ui-runtime-state.ts");

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name) {
  const node = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
}

const oldState = {
  extensionStatuses: [{ key: "extension", text: "shutdown" }],
  extensionWidgets: [{ key: "extension", lines: ["shutdown"], placement: "aboveEditor" }],
  thinkingLevel: "high",
};
function setup({ deferUiUpdates = false } = {}) {
  let statuses = [], widgets = [];
  const levels = [];
  const pendingUpdates = [];
  const update = (field, value) => {
    const apply = () => {
      if (field === "status") statuses = typeof value === "function" ? value(statuses) : value;
      else widgets = typeof value === "function" ? value(widgets) : value;
    };
    if (deferUiUpdates) pendingUpdates.push(apply);
    else apply();
  };
  const context = createContext({
    sessionIdRef: { current: "s1" }, askQuestionnaireRef: { current: null },
    mergeExtensionUiSnapshot,
    setExtensionStatuses: value => update("status", value),
    setExtensionWidgets: value => update("widget", value),
    filterVisibleExtensionWidgets: value => value ?? [],
    runtimeReadSeqRef: { current: 0 }, lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 }, lastAppliedThinkingSeqRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    queueStateGenerationRef: { current: 0 }, compactionEpochRef: { current: 0 },
    thinkingChoiceRevisionRef: { current: 0 }, runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    setIsCompacting() {}, updateQueuedMessages() {}, normalizeQueuedMessages: value => value,
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    applyContextUsage() {}, setContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: value => levels.push(value) },
    newSessionCwd: null, onPendingNewSessionEvent() {},
  });
  for (const name of ["beginRuntimeRead", "applyRuntimeState", "applyRuntimeSnapshot", "handleExtensionUiRequest"]) {
    context[name] = callback(name).runInContext(context);
  }
  const view = () => JSON.parse(JSON.stringify({ statuses, widgets }));
  const flush = () => {
    const views = [];
    while (pendingUpdates.length) { pendingUpdates.shift()(); views.push(view()); }
    return views;
  };
  return { context, view, levels, flush };
}
const empty = { statuses: [], widgets: [] };

test("重载删除事件先到、旧运行态响应后到时，不得恢复已删除的扩展UI", async () => {
  const { context, view, levels } = setup();
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), oldState);
  const read = context.beginRuntimeRead();
  const response = Promise.withResolvers();
  const pending = response.promise.then(state => context.applyRuntimeSnapshot(read, state));
  // 真实请求回调仍在等待；先交付服务端清理发出的两条事件，不依赖重载成功后的刷新。
  context.handleExtensionUiRequest({ method: "setStatus", statusKey: "extension" });
  context.handleExtensionUiRequest({ method: "setWidget", widgetKey: "extension" });
  assert.deepEqual(view(), empty);
  response.resolve(oldState);
  await pending;
  assert.deepEqual(view(), empty);
  assert.equal(levels.length, 2, "扩展UI失效不应阻止仍可应用的其它字段");
});

test("没有实时事件时，较新扩展UI快照也不能被迟到的旧快照覆盖", () => {
  const { context, view } = setup();
  const earlier = context.beginRuntimeRead();
  const later = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(later, { extensionStatuses: [], extensionWidgets: [] });
  context.applyRuntimeSnapshot(earlier, oldState);
  assert.deepEqual(view(), empty);
  // 新请求失败、没有投影时，不影响此前仍然成功返回的读取。
  const valid = context.beginRuntimeRead();
  context.beginRuntimeRead();
  context.applyRuntimeSnapshot(valid, oldState);
  assert.deepEqual(view(), { statuses: oldState.extensionStatuses, widgets: oldState.extensionWidgets });
});

for (const field of ["status", "widget"]) test(`${field} 事件只使自己的快照字段失效`, () => {
  const { context, view } = setup();
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), oldState);
  const read = context.beginRuntimeRead();
  if (field === "status") context.handleExtensionUiRequest({ method: "setStatus", statusKey: "extension" });
  else context.handleExtensionUiRequest({ method: "setWidget", widgetKey: "extension" });
  context.applyRuntimeSnapshot(read, oldState);
  assert.deepEqual(view(), {
    statuses: field === "status" ? [] : oldState.extensionStatuses,
    widgets: field === "widget" ? [] : oldState.extensionWidgets,
  });
});

for (const field of ["status", "widget"]) for (const action of ["update", "delete"]) test(`${field} 重连补读修正A，保留请求后B的${action}`, async () => {
  const { context, view } = setup();
  const state = items => ({
    extensionStatuses: field === "status" ? items.map(([key, value]) => ({ key, text: value })) : [],
    extensionWidgets: field === "widget" ? items.map(([key, value]) => ({ key, lines: [value], placement: "aboveEditor" })) : [],
  });
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), state([["A", "stale A"], ["B", "stale B"]]));
  // 断线期间A已经在服务端删除，补读取到正确列表，但此时响应尚未交给页面。
  const read = context.beginRuntimeRead();
  const response = Promise.withResolvers();
  const pending = response.promise.then(snapshot => context.applyRuntimeSnapshot(read, snapshot));
  if (field === "status") context.handleExtensionUiRequest({ method: "setStatus", statusKey: "B", statusText: action === "update" ? "live B" : undefined });
  else context.handleExtensionUiRequest({ method: "setWidget", widgetKey: "B", widgetLines: action === "update" ? ["live B"] : undefined });
  response.resolve(state([["B", "snapshot B"]]));
  await pending;
  const expected = state(action === "update" ? [["B", "live B"]] : []);
  assert.deepEqual(view(), { statuses: expected.extensionStatuses, widgets: expected.extensionWidgets });
});

for (const field of ["status", "widget"]) test(`${field} 快照采纳后回收历史键，只保留读取后的删除记录`, () => {
  const { context, view } = setup();
  const event = (key, value) => field === "status"
    ? { method: "setStatus", statusKey: key, statusText: value }
    : { method: "setWidget", widgetKey: key, widgetLines: value === undefined ? undefined : [value] };
  const revisions = field === "status" ? context.extensionStatusKeyRevisionsRef.current : context.extensionWidgetKeyRevisionsRef.current;
  const older = context.beginRuntimeRead();
  for (let i = 0; i < 500; i++) {
    context.handleExtensionUiRequest(event(`history-${i}`, "value"));
    context.handleExtensionUiRequest(event(`history-${i}`));
  }
  assert.equal(revisions.size, 500);
  assert.deepEqual(view(), empty);
  const read = context.beginRuntimeRead();
  context.handleExtensionUiRequest(event("pending", "value"));
  context.handleExtensionUiRequest(event("pending"));
  const snapshot = {
    extensionStatuses: field === "status" ? [{ key: "pending", text: "stale" }] : [],
    extensionWidgets: field === "widget" ? [{ key: "pending", lines: ["stale"] }] : [],
  };
  context.applyRuntimeSnapshot(read, snapshot);
  assert.equal(revisions.size, 1, "读取前的500个历史键应被回收");
  assert.ok(revisions.has("pending"), "读取后的删除仍须保护在途响应");
  assert.deepEqual(view(), empty);
  context.applyRuntimeSnapshot(older, oldState);
  assert.deepEqual(view(), empty, "回收后更早响应仍被读取序号挡住");
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), { extensionStatuses: [], extensionWidgets: [] });
  assert.equal(revisions.size, 0, "下一份确认快照应回收剩余删除记录");
});

for (const field of ["status", "widget"]) test(`${field} 延后执行的React更新保留其版本副本，不受后续回收影响`, () => {
  const { context, view, flush } = setup({ deferUiUpdates: true });
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), oldState);
  flush();
  const read = context.beginRuntimeRead();
  context.handleExtensionUiRequest(field === "status" ? { method: "setStatus", statusKey: "extension" } : { method: "setWidget", widgetKey: "extension" });
  context.applyRuntimeSnapshot(read, oldState);
  // 两份快照的更新函数都还未执行；较新快照先回收共享版本表。
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), { extensionStatuses: [], extensionWidgets: [] });
  const revisions = field === "status" ? context.extensionStatusKeyRevisionsRef.current : context.extensionWidgetKeyRevisionsRef.current;
  assert.equal(revisions.size, 0);
  for (const state of flush()) assert.deepEqual(field === "status" ? state.statuses : state.widgets, [], "较早更新的固定副本仍阻止已删除键复活");
  assert.deepEqual(view(), empty);
});
