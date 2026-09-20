import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("偏好更新要求 revision 并返回冲突快照", () => {
  assert.match(source, /Number\.isSafeInteger\(body\.expectedRevision\)/);
  assert.match(source, /error instanceof SidebarPreferencesConflictError/);
  assert.match(source, /preferences: error\.current/);
  assert.match(source, /status: 409/);
});

test("API 仅接受受控的排序、Pin 和迁移动作", () => {
  for (const action of ["move_project", "set_project_pinned", "move_session", "set_session_pinned", "remove_projects", "remove_sessions", "merge_legacy"]) {
    assert.match(source, new RegExp(`case "${action}"`));
  }
});

test("限制偏好动作的标识数量和长度", () => {
  assert.match(source, /MAX_IDENTIFIERS = 20_000/);
  assert.match(source, /MAX_PROJECT_LENGTH = 4_096/);
  assert.match(source, /MAX_SESSION_ID_LENGTH = 512/);
  assert.match(source, /value\.length <= MAX_IDENTIFIERS/);
});
