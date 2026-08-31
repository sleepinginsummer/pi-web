import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const topBarSource = await readFile(new URL("./AppTopBar.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const topPanelSource = await readFile(new URL("../hooks/useTopPanel.ts", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("keeps actions inline above the narrow-phone breakpoint", () => {
  assert.match(mobileHookSource, /NARROW_MOBILE_QUERY = "\(max-width: 480px\)"/);
  assert.match(topBarSource, /const isNarrowMobile = useIsNarrowMobile\(\);/);
  assert.match(topBarSource, /navigation\.isMobile && !isNarrowMobile \? "auto" : "hidden"/);
  assert.match(topBarSource, /navigation\.isMobile && isNarrowMobile \? \(/);
});

test("uses a compact narrow-phone action layer", () => {
  assert.match(topBarSource, /data-mobile-toolbar=\{navigation\.isMobile \? "true" : undefined\}/);
  assert.match(topBarSource, /data-mobile-toolbar-actions="true"/);
  assert.match(topBarSource, /position: "absolute", inset: 0/);
  assert.match(topBarSource, /<MoreHorizontal[\s\S]*?<SessionTopBarControls[\s\S]*?<X/);
  assert.doesNotMatch(topBarSource, /AppearanceControls|toggleTheme|common\.language/);
});

test("keeps Shadow outside the narrow-phone action layer", () => {
  const layerStart = topBarSource.indexOf('data-mobile-toolbar-actions="true"');
  const layerEnd = topBarSource.indexOf("</div>", layerStart);
  assert.ok(layerStart > 0 && layerEnd > layerStart);
  assert.match(topBarSource.slice(0, layerStart), /<ShadowSessionToggle/);
  assert.doesNotMatch(topBarSource.slice(layerStart, layerEnd), /<ShadowSessionToggle/);
  assert.match(topBarSource.slice(layerStart, layerEnd), /hideShadow/);
});

test("only renders optional Agents and branch actions when available", () => {
  assert.match(topBarSource, /session\.agentCount > 0 && \(/);
  assert.match(topBarSource, /const hasBranches = hasSessionBranches\(navigation\.branchTree\)/);
  assert.match(topBarSource, /\{hasBranches && \(/);
  assert.match(appShellSource, /agentCount: activeSessionFamily\?\.subagents\.length \?\? 0/);
});

test("positions the Agents panel at the left and delegates session selection", () => {
  assert.match(topPanelSource, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(topPanelSource, /activePanel === "agents"[\s\S]*?left: topBarRect\.left[\s\S]*?Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/);
  assert.match(appShellSource, /<AppTopPanels/);
  assert.match(appShellSource, /onSelectSession=\{handleSelectSession\}/);
});

test("hides the file slot from pointer and accessibility interaction while covered", () => {
  assert.match(topBarSource, /aria-hidden=\{mobileToolbarMoreOpen \? true : undefined\}/);
  assert.match(topBarSource, /visibility: mobileToolbarMoreOpen \? "hidden" : "visible"/);
  assert.match(topBarSource, /pointerEvents: mobileToolbarMoreOpen \? "none" : "auto"/);
});

test("closes the action layer on outside click, Escape, layout, and identity changes", () => {
  assert.match(topBarSource, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(topBarSource, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(topBarSource, /event\.key === "Escape"/);
  assert.match(topBarSource, /\[isNarrowMobile, navigation\.isMobile, session\.identityKey\]/);
});

test("keeps expanded actions open until an explicit close condition", () => {
  assert.match(topBarSource, /onClick=\{\(\) => setMobileToolbarMoreOpen\(true\)\}/);
  assert.match(topBarSource, /label=\{translate\("chat\.close"\)\} onClick=\{\(\) => setMobileToolbarMoreOpen\(false\)\}/);
  assert.doesNotMatch(topPanelSource, /setMobileToolbarMoreOpen/);
});

test("places mobile trust warnings below the toolbar", () => {
  assert.match(topBarSource, /data-mobile-trust-banner=\{navigation\.isMobile \? "true" : undefined\}/);
  assert.match(topBarSource, /\{navigation\.isMobile && projectTrustWarning\}/);
  assert.match(sidebarSource, /visibilitychange/);
  assert.match(sidebarSource, /\/api\/git\/context\?cwd=/);
});
