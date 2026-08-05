import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("重复选择当前会话不会重挂载聊天窗口", () => {
  assert.match(source, /activeSessionIdRef\.current === session\.id\) return/);
});

test("会话切换只更新地址栏而不发起 App Router 导航", () => {
  assert.match(source, /window\.history\.replaceState\(window\.history\.state/);
  assert.match(source, /replaceSessionUrl\(session\.id\)/);
});

test("新会话转正后清理对应目录的临时草稿", () => {
  assert.match(source, /handleSessionCreated[\s\S]*?clearDraft\(`new:\$\{session\.cwd\}`\)/);
});

test("页面重新可见时刷新当前会话分支", () => {
  assert.match(source, /\/api\/git\/context\?cwd=\$\{encodeURIComponent\(selectedSession\.cwd\)\}/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(source, /if \(response\.ok\) handleSessionListRefresh\(\)/);
});
