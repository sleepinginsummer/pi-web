import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { portablePathIdentity } from "../lib/path-equality.ts";
import { DEFAULT_PENDING_NEW_SESSION_CONTROL, reducePendingNewSession } from "../lib/pending-new-session.ts";

const source = await readFile(new URL("./useSessionNavigation.ts", import.meta.url), "utf8");

function sliceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function createHarness() {
  const autoTopPinned = [];
  const mirrored = new Map();
  const context = vm.createContext({
    portablePathIdentity,
    draftAutoTopPinCwdsRef: { current: new Set() },
    inFlightAutoTopPinCwdsRef: { current: new Map() },
    autoTopPinSessionIdsRef: { current: new Set() },
    activeSessionIdRef: { current: null },
    newSessionCwdRef: { current: null },
    pendingNewSessions: new Map(),
    DEFAULT_PENDING_NEW_SESSION_CONTROL,
    reducePendingNewSession,
    latestPendingNewSessionControl: (cwd) => mirrored.get(cwd) ?? null,
    mirrorPendingNewSessionControl: (cwd, control) => { mirrored.set(cwd, control); },
    clearPendingNewSessionControl: (cwd) => { mirrored.delete(cwd); },
    invalidateWorkspaceRestore() {},
    invalidateNotificationNavigation() {},
    setSelectedSession() {},
    setPendingNewSessions() {},
    setNewSessionCwd(value) { context.newSessionCwdRef.current = value; },
    setTabOpenNewSession() {},
    setTabOpenSession() {},
    bumpSessionKey() {},
    resetSessionViews() {},
    isMobile: false,
    onMobileSelect() {},
    clearDraft() {},
    releaseNewSessionMaterialization() {},
    requestSidebarLocate() {},
    onRefresh() {},
    hydrateSelectedSession() {},
    replaceSessionUrl() {},
    applySessionSelection() {},
    onAutoTopPinSession: (sessionId) => autoTopPinned.push(sessionId),
    window: {
      location: { href: "http://localhost:30141/" },
      history: { state: null, replaceState() {} },
    },
    URL,
    useCallback: (callback) => callback,
  });

  const body = [
    sliceBlock("  const newSession = useCallback", "  const sessionForked = useCallback"),
    sliceBlock("  const dispatchPending = useCallback", "  const beginInitialCwd = useCallback"),
  ].join("\n");

  const api = vm.runInContext(
    stripTypeScriptTypes(`${body}
      ({ newSession, sessionCreated, sessionCreatedInBackground, dispatchPending });
    `),
    context,
  );
  return { ...api, autoTopPinned };
}

test("从置顶分组发起新建后，前台创建完成自动置顶并消费该目录标记", () => {
  const harness = createHarness();
  harness.newSession("/repo", "/repo", { topPinOnCreate: true });
  harness.dispatchPending("/repo", { type: "START" });
  harness.dispatchPending("/repo", { type: "RUNTIME_CREATED", sessionId: "s1" });
  harness.sessionCreated({ id: "s1", path: "/s1.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 1, firstMessage: "hi" });
  assert.deepEqual(harness.autoTopPinned, ["s1"]);

  // 标记已被消费，同一目录后续普通创建不再自动置顶。
  harness.sessionCreated({ id: "s2", path: "/s2.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 1, firstMessage: "hi" });
  assert.deepEqual(harness.autoTopPinned, ["s1"]);
});

test("从置顶分组发起新建后切走，后台创建完成仍自动置顶", () => {
  const harness = createHarness();
  harness.newSession("/repo", "/repo", { topPinOnCreate: true });
  harness.dispatchPending("/repo", { type: "START" });
  harness.dispatchPending("/repo", { type: "RUNTIME_CREATED", sessionId: "s-bg" });
  harness.sessionCreatedInBackground({ id: "s-bg", path: "/s-bg.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 0, firstMessage: "bg" });
  assert.deepEqual(harness.autoTopPinned, ["s-bg"]);
});

test("置顶首发等待期间点击同目录普通新建，旧请求后台成功仍自动置顶且后续普通创建不置顶", () => {
  const harness = createHarness();
  harness.newSession("/repo", "/repo", { topPinOnCreate: true });
  harness.dispatchPending("/repo", { type: "START" });

  // 在旧请求返回前点击同目录普通新建
  harness.newSession("/repo", "/repo");

  // 旧请求继续在后台完成
  harness.dispatchPending("/repo", { type: "RUNTIME_CREATED", sessionId: "s-pinned-bg" });
  harness.sessionCreatedInBackground({ id: "s-pinned-bg", path: "/s-pinned-bg.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 0, firstMessage: "bg" });
  assert.deepEqual(harness.autoTopPinned, ["s-pinned-bg"]);

  // 随后普通新建页发出的新会话不应置顶
  harness.dispatchPending("/repo", { type: "START" });
  harness.dispatchPending("/repo", { type: "RUNTIME_CREATED", sessionId: "s-normal" });
  harness.sessionCreated({ id: "s-normal", path: "/s-normal.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 1, firstMessage: "normal" });
  assert.deepEqual(harness.autoTopPinned, ["s-pinned-bg"]);
});

test("置顶首发等待期间点击普通新建且旧请求失败时，不把置顶意图恢复给普通新建", () => {
  const harness = createHarness();
  harness.newSession("/repo", "/repo", { topPinOnCreate: true });
  harness.dispatchPending("/repo", { type: "START" });
  harness.newSession("/repo", "/repo");
  harness.dispatchPending("/repo", { type: "REQUEST_FAIL", error: "network" });

  harness.dispatchPending("/repo", { type: "START" });
  harness.dispatchPending("/repo", { type: "RUNTIME_CREATED", sessionId: "s-after-fail" });
  harness.sessionCreated({ id: "s-after-fail", path: "/s-after-fail.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 1, firstMessage: "normal" });
  assert.deepEqual(harness.autoTopPinned, []);
});

test("普通新建会清除同目录之前未消费的自动置顶标记", () => {
  const harness = createHarness();
  harness.newSession("/repo", "/repo", { topPinOnCreate: true });
  harness.newSession("/repo", "/repo");
  harness.sessionCreated({ id: "s-normal", path: "/s-normal.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 1, firstMessage: "hi" });
  assert.deepEqual(harness.autoTopPinned, []);
});
