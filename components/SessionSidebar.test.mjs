import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("仅在服务端列表缺失时合并已转正的当前会话", () => {
  assert.doesNotMatch(source, /optimisticSession/);
  assert.doesNotMatch(source, /setOptimisticSessions/);
  assert.match(
    source,
    /const visibleSessions = selectedSession && !allSessions\.some\(\(session\) => session\.id === selectedSession\.id\)\s*\? \[selectedSession, \.\.\.allSessions\]\s*:\s*allSessions/,
  );
  assert.match(source, /session\.isWorktree \? session\.cwd/);
});

test("does not reselect the active session", () => {
  assert.match(source, /if \(s\.id === selectedSessionId\) return/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("并发刷新只允许最新的会话列表请求提交结果", () => {
  assert.match(source, /const requestId = \+\+sessionLoadRequestIdRef\.current/);
  assert.match(source, /fetch\("\/api\/sessions", \{ cache: "no-store" \}\)/);
  assert.match(source, /if \(requestId !== sessionLoadRequestIdRef\.current\) return/);
});

test("会话列表加载后不抢占首屏资源预取全部历史上下文", () => {
  assert.doesNotMatch(source, /for \(const session of data\.sessions\) prefetchSessionContext/);
  assert.doesNotMatch(source, /import \{[^}]*prefetchSessionContext/);
});
test("renders projects as persistent directory rows with per-project session actions", () => {
  assert.match(source, /visibleProjects\.map\(\(project\) =>/);
  assert.match(source, /projectName\(project\)/);
  assert.match(source, /onClick=\{\(\) => handleNewSession\(project\)\}/);
  assert.match(source, /buildSessionTree\(projectSessions, sessionOrder\)/);
  assert.match(source, /projectName\(left\)\.localeCompare\(projectName\(right\)/);
  assert.match(source, /setProjectPendingRemoval\(project\)/);
  assert.match(source, /sidebar\.removeProjectDescription/);
  assert.match(source, /const showWorktreeSwitcher = false/);
  assert.match(source, /useState<string\[]>\(\[\]\)/);
  assert.match(source, /fetch\("\/api\/project-directories", \{ cache: "no-store" \}\)/);
  assert.match(source, /setKnownProjects\(projects\)/);
});
