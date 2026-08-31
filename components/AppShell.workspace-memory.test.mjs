import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
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
    /useEffect\(\(\) => \{\s+if \(!selectedSession\) return;[\s\S]*?setLastOpenSession\(workspaceKey, selectedSession\.id\);\s+\}, \[selectedSession\]\);/,
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

test("sidebar forwards the server project identity with cwd changes", () => {
  assert.match(sidebarSource, /const projectKeyFor = useCallback/);
  assert.match(sidebarSource, /onCwdChange\?\.\(selectedCwd, projectRootFor\(selectedCwd\), projectKeyFor\(selectedCwd\)\)/);
});
