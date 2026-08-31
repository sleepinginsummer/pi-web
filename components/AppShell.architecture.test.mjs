import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const topBar = await readFile(new URL("./AppTopBar.tsx", import.meta.url), "utf8");
const filePanelHook = await readFile(new URL("../hooks/useFilePanel.ts", import.meta.url), "utf8");
const topPanelHook = await readFile(new URL("../hooks/useTopPanel.ts", import.meta.url), "utf8");
const sessionNavigationHook = await readFile(new URL("../hooks/useSessionNavigation.ts", import.meta.url), "utf8");
const sessionNotificationsHook = await readFile(new URL("../hooks/useSessionNotifications.ts", import.meta.url), "utf8");
const completionNotificationHook = await readFile(new URL("../hooks/useCompletionNotification.ts", import.meta.url), "utf8");
const floatingNotificationHook = await readFile(new URL("../hooks/useFloatingSessionNotifications.ts", import.meta.url), "utf8");

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
  assert.match(appShell, /useSessionNotifications\(/);
  assert.match(appShell, /<FloatingSessionNotifications/);
  assert.doesNotMatch(appShell, /setNotifications|upsertFloatingSessionNotification|dismissFloatingSessionNotification/);
});

test("keeps notification delivery and floating queue behind neutral contracts", () => {
  assert.match(sessionNotificationsHook, /useCompletionNotification/);
  assert.match(sessionNotificationsHook, /useFloatingSessionNotifications/);
  assert.match(completionNotificationHook, /@\/lib\/session-notifications/);
  assert.match(floatingNotificationHook, /@\/lib\/session-notifications/);
  assert.doesNotMatch(floatingNotificationHook, /useCompletionNotification/);
});

test("keeps top bar responsibilities split into focused controls", () => {
  assert.match(topBar, /function SessionTopBarControls/);
  assert.match(topBar, /<BranchNavigator/);
  assert.match(topBar, /<ShadowSessionToggle/);
  assert.match(topBar, /<SessionStatsButton/);
  assert.doesNotMatch(topBar, /AppearanceControls|supportedLocales|toggleTheme|common\.language/);
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

test("routes session-list completion refreshes through one coordinator", () => {
  const agentEndSource = appShell.slice(
    appShell.indexOf("const handleAgentEnd = useCallback"),
    appShell.indexOf("const handleSessionListRefresh = useCallback"),
  );

  assert.doesNotMatch(agentEndSource, /setRefreshKey/);
  assert.match(agentEndSource, /setExplorerRefreshKey/);
  assert.match(appShell, /useSessionListRefreshCoordinator\(handleSessionListRefresh\)/);
  assert.equal((appShell.match(/handleSessionListRefresh/g) ?? []).length, 2);
  assert.match(appShell, /onSessionListRefresh=\{requestAgentSessionListRefresh\}/);
});
