import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const navigationSource = await readFile(new URL("../hooks/useSessionNavigation.ts", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("explicit navigation invalidates a pending workspace restore", () => {
  for (const callback of [
    "selectSession",
    "newSession",
    "sessionCreated",
    "sessionForked",
    "sessionDeleted",
    "leaveWorkspace",
  ]) {
    const start = navigationSource.indexOf(`const ${callback} = useCallback`);
    const end = navigationSource.indexOf("\n  const ", start + 1);
    assert.notEqual(start, -1, `${callback} callback not found`);
    assert.match(navigationSource.slice(start, end), /invalidateWorkspaceRestore\(\);/);
  }
});

test("persists every selected-session transition through one effect", () => {
  assert.match(
    navigationSource,
    /useEffect\(\(\) => \{\s+if \(!selectedSession\) return;[\s\S]*?setLastOpenSession\(workspaceKey, selectedSession\.id\);\s+setTabOpenSession\(selectedSession\.id\);\s+\}, \[selectedSession\]\);/,
  );
});

test("keeps chat scroll positions in page memory by session id", () => {
  assert.match(appShellSource, /useRef\(new Map<string, ChatReadingPosition>\(\)\)/);
  assert.match(appShellSource, /sessionScrollPositionsRef\.current\.set\(sessionId, position\)/);
  assert.match(appShellSource, /initialScrollPosition=\{selectedSession \? sessionScrollPositionsRef\.current\.get\(selectedSession\.id\) \?\? null : null\}/);
  assert.match(appShellSource, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  assert.doesNotMatch(appShellSource, /localStorage[^\n]*sessionScroll/i);
});

test("keeps a pending scroll restore through initial leaf hydration", () => {
  assert.match(chatWindowSource, /const previousLeafIdRef = useRef<string \| null \| undefined>\(undefined\)/);
  assert.match(
    chatWindowSource,
    /if \(loading\) return;\s+\/\/[^\n]+\s+if \(previousLeafIdRef\.current === undefined\) \{\s+previousLeafIdRef\.current = activeLeafId;\s+return;/,
  );
});

test("restores only a live session that still belongs to the workspace", () => {
  assert.match(navigationSource, /const restoreWorkspaceContext = useCallback/);
  assert.match(navigationSource, /token !== workspaceRestoreTokenRef\.current/);
  assert.match(navigationSource, /workspaceKeyOf\(session\) !== workspaceKey/);
  assert.match(navigationSource, /clearLastOpen\(workspaceKey\)/);
  assert.match(navigationSource, /applySessionSelection\(session\)/);
});

test("restoration runs only after a cross-workspace context reset", () => {
  const start = appShellSource.indexOf("const handleCwdChange = useCallback");
  const end = appShellSource.indexOf("\n\n\n  // Global keyboard shortcuts", start);
  const callback = appShellSource.slice(start, end);
  assert.match(callback, /const newProject = projectKey \?\? projectRoot \?\? cwd/);
  assert.match(callback, /if \(currentProject === newProject\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(callback, /leaveWorkspace\(cwd\);[\s\S]*?restoreWorkspaceContext\(newProject\);/);
});

test("explicit new-session navigation cannot restore the workspace's old session", () => {
  const start = appShellSource.indexOf("const handleCwdChange = useCallback");
  const end = appShellSource.indexOf("\n\n\n  // Global keyboard shortcuts", start);
  const callback = appShellSource.slice(start, end);
  const guardIndex = callback.indexOf("if (!selectedSession && newSessionCwd === cwd)");
  const restoreIndex = callback.indexOf("restoreWorkspaceContext(newProject)");

  assert.ok(guardIndex >= 0, "缺少新增会话 cwd 同步保护");
  assert.ok(guardIndex < restoreIndex, "新增会话保护必须先于旧会话恢复");
  assert.match(callback, /newSessionCwd[\s\S]*?restoreWorkspaceContext/);
});

test("sidebar forwards the server project identity with cwd changes", () => {
  assert.match(sidebarSource, /const projectKeyFor = useCallback/);
  assert.match(sidebarSource, /onCwdChange\?\.\(selectedCwd, projectRootFor\(selectedCwd\), projectKeyFor\(selectedCwd\)\)/);
});

test("fresh-session drafts remain keyed by cwd across session and workspace navigation", () => {
  assert.match(
    chatWindowSource,
    /draftKey=\{session\?\.id \?\? \(newSessionCwd \? `new:\$\{newSessionCwd\}` : undefined\)\}/,
  );

  const newSessionStart = navigationSource.indexOf("const newSession = useCallback");
  const newSessionEnd = navigationSource.indexOf("\n  const sessionCreated", newSessionStart);
  const newSessionCallback = navigationSource.slice(newSessionStart, newSessionEnd);
  assert.doesNotMatch(newSessionCallback, /clearDraft\(/);
});
