import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("URL 链接的会话已不存在时，侧栏采用的项目保持空白新会话（#1168）", () => {
  assert.match(source, /const initialLinkedSessionId = linkedSessionId\(initialNavigation\);/);
  assert.match(source, /completeInitialRestore\(\);\s*if \(initialLinkedSessionId\) skipWorkspaceRestoreRef\.current = true;/);
  // 只影响紧接着的一次项目切换，之后照常恢复。
  assert.match(source, /const skipWorkspaceRestore = skipWorkspaceRestoreRef\.current;\s*skipWorkspaceRestoreRef\.current = false;/);
  assert.match(source, /if \(!skipWorkspaceRestore\) restoreWorkspaceContext\(newProject\);/);
});
