import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const topBar = await readFile(new URL("./AppTopBar.tsx", import.meta.url), "utf8");
const filePanelHook = await readFile(new URL("../hooks/useFilePanel.ts", import.meta.url), "utf8");
const topPanelHook = await readFile(new URL("../hooks/useTopPanel.ts", import.meta.url), "utf8");
const sessionNavigationHook = await readFile(new URL("../hooks/useSessionNavigation.ts", import.meta.url), "utf8");

test("keeps AppShell as an orchestrator instead of restoring inline feature ownership", () => {
  assert.match(appShell, /useProjectTrust\(/);
  assert.match(appShell, /useSessionPresentation\(/);
  assert.match(appShell, /useSessionAutoName\(/);
  assert.match(appShell, /useSessionNavigation\(/);
  assert.match(appShell, /useFilePanel\(/);
  assert.match(appShell, /<AppTopBar/);
  assert.match(appShell, /<AppTopPanels/);
  assert.doesNotMatch(appShell, /setFileTabs|setRightPanelOpen|const handleOpenFile|const handleCloseFileTab/);
  assert.doesNotMatch(appShell, /new ResizeObserver/);
  assert.doesNotMatch(appShell, /fetch\(`?\/api\/project-trust|setProjectTrust|setSessionStats|setSystemPrompt|setContextUsage/);
});

test("keeps top bar responsibilities split into focused controls", () => {
  assert.match(topBar, /function AppearanceControls/);
  assert.match(topBar, /function SessionTopBarControls/);
  assert.match(topBar, /<BranchNavigator/);
  assert.match(topBar, /<ShadowSessionToggle/);
  assert.match(topBar, /<SessionStatsButton/);
  assert.doesNotMatch(topBar, /supportedLocales/);
});

test("keeps file panel state independent from presentation components", () => {
  assert.match(filePanelHook, /@\/lib\/file-panel-model/);
  assert.doesNotMatch(filePanelHook, /@\/components\/TabBar/);
});

test("does not duplicate branch dropdown measurement in the generic top panel hook", () => {
  assert.match(topPanelHook, /activePanel === "branches"/);
  assert.match(topPanelHook, /setPosition\(null\)/);
});

test("exposes semantic session navigation commands instead of mutable internals", () => {
  const publicApi = sessionNavigationHook.slice(sessionNavigationHook.lastIndexOf("return {"));
  assert.match(publicApi, /applyGeneratedTitle/);
  assert.match(publicApi, /leaveWorkspace/);
  assert.match(publicApi, /updateDraftCwd/);
  assert.doesNotMatch(publicApi, /setSelectedSession|setNewSessionCwd|setInitialSessionRestored/);
  assert.doesNotMatch(publicApi, /activeSessionIdRef|suppressCwdBumpRef/);
});
