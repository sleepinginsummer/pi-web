import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const topBarSource = await readFile(new URL("./AppTopBar.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const topPanelSource = await readFile(new URL("../hooks/useTopPanel.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("places mobile actions in a scrollable vertical menu below the toolbar", () => {
  assert.match(topBarSource, /navigation.isMobile && session.show && mobileToolbarMoreOpen/);
  assert.match(topBarSource, /<MoreHorizontal[\s\S]*?className="mobile-top-bar-menu"[\s\S]*?stacked/);
  assert.match(css, /\.mobile-top-bar-menu\s*\{[^}]*position: absolute[^}]*overflow-y: auto/);
  assert.match(css, /\.mobile-top-bar-menu-rows\s*\{[^}]*flex-direction: column/);
});

// 系统配色监听只在 useTheme 被挂载时存在；AppShell 是唯一全程存活的位置，
// 少这一句会让跟随系统的页面在系统切换深浅色后停留在旧主题（e2e code-background 覆盖）。
test("keeps the system theme subscription mounted at the app root", () => {
  assert.match(appShellSource, /import \{ useTheme \} from "@\/hooks\/useTheme"/);
  assert.match(appShellSource, /useTheme\(\);/);
});

test("keeps session switches together after the core actions", () => {
  assert.match(topBarSource, /showLabel=\{stacked\}[\s\S]*?<ShadowSessionToggle[\s\S]*?<SystemPromptAddonToggle[\s\S]*?<ObserverTopBarToggle/);
});

test("only renders optional Agents and branch actions when available", () => {
  assert.match(topBarSource, /if \(!session\.agentsBadge\) return null;/);
  assert.match(topBarSource, /const hasBranches = hasSessionBranches\(navigation\.branchTree\)/);
  assert.match(topBarSource, /\{hasBranches && \(/);
  assert.match(appShellSource, /agentsBadge: activeSessionFamily \? getAgentsBadge\(activeSessionFamily\.subagents, runningSessionIds\) : null/);
});

test("positions the Agents panel at the left and delegates session selection", () => {
  assert.match(topPanelSource, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(topPanelSource, /activePanel === "agents"[\s\S]*?left: topBarRect\.left[\s\S]*?Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/);
  assert.match(appShellSource, /<AppTopPanels/);
  assert.match(appShellSource, /onSelectSession=\{handleSelectAgentFromStrip\}/);
});


test("closes the menu on outside click, Escape, layout, and identity changes", () => {
  assert.ok(topBarSource.includes("event.composedPath().includes(toolbar)"));
  assert.ok(topBarSource.includes('document.addEventListener("pointerdown", handlePointerDown, true)'));
  assert.ok(topBarSource.includes('event.key !== "Escape"'));
  assert.ok(topBarSource.includes("[navigation.isMobile, session.identityKey]"));
});

test("places mobile trust warnings below the toolbar", () => {
  assert.match(topBarSource, /data-mobile-trust-banner=\{navigation\.isMobile \? "true" : undefined\}/);
  assert.match(topBarSource, /\{navigation\.isMobile && projectTrustWarning\}/);
  assert.match(sidebarSource, /visibilitychange/);
  assert.match(sidebarSource, /\/api\/git\/context\?cwd=/);
});

test("移动端大纲入口不依赖可能滞后的列表消息数", () => {
  const outlineProps = appShellSource.match(/outline=\{\{([\s\S]*?)\}\}/)?.[1] ?? "";
  const availableExpression = outlineProps.match(/available:\s*([^\n]+),/)?.[1];
  assert.ok(availableExpression, "AppShell 向大纲入口提供可用状态");
  const available = new Function("selectedSession", `return (${availableExpression});`);
  assert.equal(available({ id: "saved", messageCount: 0 }), true, "会话已有正文但列表计数未刷新时，仍保留大纲入口");
  assert.equal(available({ id: "saved", messageCount: 1 }), true);
  assert.equal(available(null), false, "尚未创建会话时不显示入口");
});
