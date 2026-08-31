import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const runningSessionsHookSource = await readFile(new URL("../hooks/useRunningSessions.ts", import.meta.url), "utf8");
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

test("keeps the pinned marker visible when a session is selected", () => {
  assert.match(sessionItemSource, /position: "relative"/);
  assert.match(sessionItemSource, /paddingRight: isPinned \? 32 : 8/);
  assert.match(sessionItemSource, /background: confirmDelete[\s\S]*?: isSelected \? "var\(--bg-selected\)" : hovered/);
  assert.match(sessionItemSource, /background: "#eab308"[\s\S]*?borderBottomLeftRadius: 5/);
  assert.match(sessionItemSource, /PinIcon size=\{12\}[^>]*transform: "rotate\(45deg\)"/);
  assert.match(sessionItemSource, /PinIcon size=\{14\}[^>]*transform: "rotate\(45deg\)"/);
  assert.doesNotMatch(sessionItemSource, /borderTop: "5px solid #a16207"/);
  assert.match(sessionItemSource, /borderLeft: confirmDelete[\s\S]*?: isSelected \? "2px solid var\(--accent\)" : "2px solid transparent"/);
  assert.match(sessionItemSource, /aria-pressed=\{isPinned\}/);
});

test("仅在服务端列表缺失时合并已转正的当前会话", () => {
  assert.doesNotMatch(source, /optimisticSession/);
  assert.doesNotMatch(source, /setOptimisticSessions/);
  assert.match(
    source,
    /const visibleSessions = useMemo\([\s\S]*?selectedSession && !allSessions\.some\(\(session\) => session\.id === selectedSession\.id\)[\s\S]*?\? \[selectedSession, \.\.\.allSessions\][\s\S]*?: allSessions/,
  );
  assert.match(source, /session\.isWorktree \? session\.cwd/);
});

test("does not reselect the active session", () => {
  assert.match(source, /if \(s\.id === selectedSessionId\) return/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.match(appShellSource, /useRunningSessions\(\)/);
  assert.doesNotMatch(source, /useRunningSessions\(\)/);
  assert.doesNotMatch(runningSessionsHookSource, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(runningSessionsHookSource, /fetch\("\/api\/agent\/running"/);
  assert.match(runningSessionsHookSource, /document\.visibilityState !== "visible"/);
  assert.match(runningSessionsHookSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
});

test("keeps running transitions and completion notifications outside the sidebar", () => {
  assert.match(appShellSource, /useRunningSessionTransitions\(runningSessionIds, selectedSession\?\.id \?\? null\)/);
  assert.match(appShellSource, /useBackgroundCompletionNotifications\(/);
  assert.match(source, /runningSessionTransitions\.revision/);
  assert.doesNotMatch(source, /diffRunningSessions|onBackgroundSessionComplete|notifySession/);
});

test("refreshes Git context before one visible-tab session-list load", () => {
  const visibilitySource = source.slice(
    source.indexOf("const refreshVisibleSessions = async"),
    source.indexOf("const initialLoadDone"),
  );
  assert.ok(visibilitySource.indexOf("/api/git/context") < visibilitySource.indexOf("await loadSessions(false)"));
  assert.equal((visibilitySource.match(/loadSessions\(false\)/g) ?? []).length, 1);
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

test("shows running and unread activity at project scope", () => {
  assert.match(source, /const projectActivity = useMemo/);
  assert.match(source, /showProjectActivity\(projectActivity\.get\(project\), t\)/);
  assert.match(source, /hasOtherWorkspaceActivity/);
});
