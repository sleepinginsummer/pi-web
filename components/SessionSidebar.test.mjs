import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const runningSessionsHookSource = await readFile(new URL("../hooks/useRunningSessions.ts", import.meta.url), "utf8");
const sessionListHookSource = await readFile(new URL("../hooks/useSessionList.ts", import.meta.url), "utf8");

test("restores and persists the file explorer state", () => {
  assert.match(source, /setExplorerOpen\(loadExplorerOpen\(\)\)/);
  assert.match(source, /saveExplorerOpen\(nextOpen\)/);
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
    source.indexOf("// Persist unread markers"),
  );
  assert.ok(visibilitySource.indexOf("/api/git/context") < visibilitySource.indexOf("await loadSessions(false)"));
  assert.equal((visibilitySource.match(/loadSessions\(false\)/g) ?? []).length, 1);
});

test("会话列表并发状态由独立 hook 统一管理", () => {
  assert.match(source, /useSessionList\(\{ refreshKey, onSessionsChange \}\)/);
  assert.match(sessionListHookSource, /new LatestRequestGate\(\)/);
  assert.match(sessionListHookSource, /const generation = requestGate\.begin\(requestKey\)/);
  assert.match(sessionListHookSource, /if \(!requestGate\.isLatest\(requestKey, generation\)\) return/);
  assert.match(
    sessionListHookSource,
    /finally \{[\s\S]*?if \(requestGate\.isLatest\(requestKey, generation\)\) setLoading\(false\);[\s\S]*?requestGate\.finish\(requestKey\)/,
  );
  assert.doesNotMatch(sessionListHookSource, /showInitialLoading &&[^\n]*setLoading\(false\)/);
  assert.match(sessionListHookSource, /const commitSessions = useCallback/);
  assert.match(sessionListHookSource, /removeSessions: \(sessionIds: Iterable<string>\) => void/);
  assert.match(sessionListHookSource, /requestGateRef\.current\.invalidate\("session-list"\)/);
  assert.doesNotMatch(sessionListHookSource, /setSessions: Dispatch/);
  assert.match(source, /removeSessions\(sessions\.map\(\(session\) => session\.id\)\)/);
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

test("reopens the custom directory picker at the last successful path", () => {
  assert.match(source, /const handleCustomPathClick = useCallback\(\(\) => \{\s*setCustomPathValue\(loadLastCustomCwd\(\)\);/);
  assert.match(source, /const cwd = data\.cwd \?\? validated\.cwd;[\s\S]*?saveLastCustomCwd\(cwd\);[\s\S]*?setCustomPathValue\(cwd\)/);
  assert.match(source, /<DirectoryPicker[\s\S]*?initialPath=\{customPathValue \|\| undefined\}/);
  assert.doesNotMatch(source, /setCustomPathValue\(""\)/);
});

test("shows running and unread activity at project scope", () => {
  assert.match(source, /const projectActivity = useMemo/);
  assert.match(source, /showProjectActivity\(projectActivity\.get\(project\), t\)/);
  assert.match(source, /hasOtherWorkspaceActivity/);
});
