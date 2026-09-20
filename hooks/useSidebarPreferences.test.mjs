import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useSidebarPreferences.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../lib/sidebar-preferences-client.ts", import.meta.url), "utf8");

test("窗口重新聚焦或恢复可见时从服务端同步", () => {
  assert.match(source, /window\.addEventListener\("focus", refreshAfterWrites\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshAfterWrites\)/);
  assert.match(source, /operationChainRef\.current = operationChainRef\.current\.then\(refresh\)/);
});

test("共享 reducer 同时驱动乐观状态和服务端动作", () => {
  assert.match(source, /reduceSidebarPreferences\(preferencesRef\.current, action, false\)/);
  assert.doesNotMatch(source, /localStorage/);
  assert.match(clientSource, /SESSION_ORDER_STORAGE_KEY/);
  assert.match(clientSource, /PINNED_SESSIONS_STORAGE_KEY/);
});

test("普通更新通过 adapter 在冲突后有界重放", () => {
  assert.match(source, /patchSidebarPreferencesWithRetry\(revisionRef\.current, action\)/);
  assert.match(clientSource, /rebaseSidebarPreferenceAction\(first\.preferences, action\)/);
  assert.equal((clientSource.match(/if \(!first\.conflict\)/g) ?? []).length, 1);
});

test("会话清理只提交首次完整列表之后明确消失的 ID", () => {
  assert.match(source, /previousSessionIdsRef/);
  assert.match(source, /const removed = \[\.\.\.previous\]\.filter/);
  assert.match(source, /enqueue\(\{ type: "remove_sessions", ids: removed \}\)/);
  assert.doesNotMatch(source, /prune_sessions|validIds/);
});

test("旧浏览器偏好只在服务端迁移未完成时提交", () => {
  assert.match(source, /!snapshot\.legacyMigrationCompleted && hasLegacy/);
  assert.match(source, /if \(snapshot\.legacyMigrationCompleted\) clearLegacySidebarPreferences\(\)/);
  assert.match(source, /operationChainRef\.current = operationChainRef\.current\.then\(loadAndMigrate\)/);
});
