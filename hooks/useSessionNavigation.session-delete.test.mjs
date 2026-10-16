import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./useSessionNavigation.ts", import.meta.url), "utf8");

function sessionDeletedBody() {
  const start = source.indexOf("  const sessionDeleted = useCallback");
  const end = source.indexOf("  const dispatchPending = useCallback", start);
  assert.notEqual(start, -1, "sessionDeleted callback not found");
  assert.notEqual(end, -1, "dispatchPending callback not found after sessionDeleted");
  return source.slice(start, end);
}

// `captured` 模拟点击删除时闭包捕获的选择，`active` 是 DELETE 完成时 ref 中的最新选择。
function runSessionDeleted(captured, active) {
  const state = { selected: [], cwd: [], keyBumps: 0, replaced: null, refreshed: false };
  const context = vm.createContext({
    selectedSession: captured,
    selectedSessionRef: { current: active },
    activeSessionIdRef: { current: active?.id ?? null },
    invalidateWorkspaceRestore() {},
    invalidateNotificationNavigation() {},
    onRefresh: () => { state.refreshed = true; },
    clearTabOpenSession() {},
    setTabOpenNewSession() {},
    setSelectedSession: (value) => { state.selected.push(value); },
    setNewSessionCwd: (value) => { state.cwd.push(value); },
    bumpSessionKey: () => { state.keyBumps += 1; },
    resetSessionViews() {},
    router: { replace: (url) => { state.replaced = url; } },
    useCallback: (callback) => callback,
  });
  vm.runInContext(stripTypeScriptTypes(`${sessionDeletedBody()}
    sessionDeleted("gone-session");
  `), context);
  return state;
}

test("删除回调读取最新选择的 ref，而非捕获的旧状态", () => {
  const body = sessionDeletedBody();
  assert.match(body, /const active = selectedSessionRef\.current;/);
  assert.doesNotMatch(body, /selectedSession\?\.id/);
  assert.doesNotMatch(body, /, selectedSession\]\);/);
});

test("用户切走后才完成的删除不会把页面拉回空白新会话", () => {
  const state = runSessionDeleted({ id: "gone-session", cwd: "/a" }, { id: "next-session", cwd: "/b" });
  assert.equal(state.refreshed, true, "侧栏列表仍然刷新");
  assert.deepEqual(state.selected, []);
  assert.deepEqual(state.cwd, []);
  assert.equal(state.keyBumps, 0);
  assert.equal(state.replaced, null);
});

test("仍停留在被删除会话时回到该目录的空白新会话", () => {
  const session = { id: "gone-session", cwd: "/a" };
  const state = runSessionDeleted(session, session);
  assert.deepEqual(state.selected, [null]);
  assert.deepEqual(state.cwd, ["/a"]);
  assert.equal(state.keyBumps, 1);
  assert.equal(state.replaced, "/");
});
