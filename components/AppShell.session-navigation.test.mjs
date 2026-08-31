import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const navigationSource = fs.readFileSync(new URL("../hooks/useSessionNavigation.ts", import.meta.url), "utf8");
const sidebarSource = fs.readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const urlSource = fs.readFileSync(new URL("../lib/session-navigation-url.ts", import.meta.url), "utf8");

test("重复选择当前会话不会重挂载聊天窗口", () => {
  assert.match(navigationSource, /activeSessionIdRef\.current === session\.id\) return/);
});

test("会话切换只更新地址栏而不发起 App Router 导航", () => {
  assert.match(urlSource, /window\.history\.replaceState\(window\.history\.state/);
  assert.match(navigationSource, /replaceSessionUrl\(session\.id\)/);
});

test("新会话转正后清理对应目录的临时草稿", () => {
  assert.match(navigationSource, /sessionCreated[\s\S]*?clearDraft\(`new:\$\{session\.cwd\}`\)/);
});

test("页面重新可见时刷新当前会话分支", () => {
  assert.match(sidebarSource, /\/api\/git\/context\?cwd=\$\{encodeURIComponent\(cwd\)\}/);
  assert.match(sidebarSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(sidebarSource, /if \(!stopped\) await loadSessions\(false\)/);
});
