import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  emptySidebarPreferences,
  orderProjectsByPreference,
  reconcileSessionPreferenceOrder,
  rebaseSidebarPreferenceAction,
  reduceSidebarPreferences,
} from "./sidebar-preference-state.ts";

const {
  SidebarPreferencesConflictError,
  readSidebarPreferences,
  removeSidebarPreferenceIds,
  updateSidebarPreferences,
} = await createJiti(import.meta.url).import("./sidebar-preferences.ts");

test("目录和会话顺序使用同一动作归约器", () => {
  let state = emptySidebarPreferences();
  state = reduceSidebarPreferences(state, {
    type: "move_project",
    source: "/b",
    target: "/a",
    visibleIds: ["/a", "/b", "/c"],
  }, true);
  state = reduceSidebarPreferences(state, {
    type: "move_session",
    source: "s3",
    target: "s1",
    visibleIds: ["s1", "s2", "s3"],
  }, true);

  assert.deepEqual(state.projectOrder, ["/b", "/a", "/c"]);
  assert.deepEqual(state.sessionOrder, ["s3", "s1", "s2"]);
  assert.equal(state.revision, 2);
});

test("Pin 动作与一次性旧偏好迁移不会复活已取消标记", () => {
  const migrated = reduceSidebarPreferences(emptySidebarPreferences(), {
    type: "merge_legacy",
    sessionOrder: ["s2", "s1"],
    pinnedSessionIds: ["s1"],
  }, true);
  const unpinned = reduceSidebarPreferences(migrated, {
    type: "set_session_pinned",
    sessionId: "s1",
    pinned: false,
  }, true);
  const repeatedMigration = reduceSidebarPreferences(unpinned, {
    type: "merge_legacy",
    sessionOrder: ["s1", "s2"],
    pinnedSessionIds: ["s1"],
  }, true);

  assert.equal(repeatedMigration, unpinned);
  assert.deepEqual(repeatedMigration.pinnedSessionIds, []);
  assert.equal(repeatedMigration.legacyMigrationCompleted, true);
});

test("删除增量只清理明确移除的顺序与 Pin 标识", () => {
  const current = {
    ...emptySidebarPreferences(),
    projectOrder: ["/a", "/b"],
    pinnedProjectPaths: ["/a", "/b"],
    sessionOrder: ["s1", "s2"],
    pinnedSessionIds: ["s1", "s2"],
  };
  const withoutProject = reduceSidebarPreferences(current, { type: "remove_projects", ids: ["/a"] }, true);
  const next = reduceSidebarPreferences(withoutProject, { type: "remove_sessions", ids: ["s1"] }, true);

  assert.deepEqual(next.projectOrder, ["/b"]);
  assert.deepEqual(next.pinnedProjectPaths, ["/b"]);
  assert.deepEqual(next.sessionOrder, ["s2"]);
  assert.deepEqual(next.pinnedSessionIds, ["s2"]);
});

test("排序补齐新对象并清理已不存在对象", () => {
  assert.deepEqual(orderProjectsByPreference(["/c", "/a", "/b"], ["/b", "/missing"]), ["/b", "/a", "/c"]);
  assert.deepEqual(reconcileSessionPreferenceOrder([
    { id: "new", created: "2026-02-02" },
    { id: "old", created: "2026-01-01" },
  ], ["missing", "old"]), ["new", "old"]);
});

test("冲突重放会使用服务端最新顺序作为拖拽基线", () => {
  const latest = {
    ...emptySidebarPreferences(),
    revision: 4,
    projectOrder: ["/c", "/a", "/b"],
  };
  const rebased = rebaseSidebarPreferenceAction(latest, {
    type: "move_project",
    source: "/b",
    target: "/c",
    visibleIds: ["/a", "/b", "/c"],
  });
  const next = reduceSidebarPreferences(latest, rebased, true);

  assert.deepEqual(next.projectOrder, ["/b", "/c", "/a"]);
});

test("服务端在文件锁内拒绝陈旧 revision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sidebar-preferences-"));
  const file = path.join(root, "preferences.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await updateSidebarPreferences(0, {
    type: "set_project_pinned",
    project: "/workspace/a",
    pinned: true,
  }, file);
  assert.equal(first.revision, 1);
  assert.deepEqual(readSidebarPreferences(file).pinnedProjectPaths, ["/workspace/a"]);
  await assert.rejects(
    updateSidebarPreferences(0, {
      type: "set_project_pinned",
      project: "/workspace/b",
      pinned: true,
    }, file),
    SidebarPreferencesConflictError,
  );
});

test("权威删除 helper 在同一锁内清理目录和会话偏好", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sidebar-remove-"));
  const file = path.join(root, "preferences.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({
    ...emptySidebarPreferences(),
    revision: 7,
    projectOrder: ["/a", "/b"],
    pinnedProjectPaths: ["/a"],
    sessionOrder: ["s1", "s2"],
    pinnedSessionIds: ["s1"],
  }));

  const next = await removeSidebarPreferenceIds({ projectPaths: ["/a"], sessionIds: ["s1"] }, file);
  assert.equal(next.revision, 8);
  assert.deepEqual(next.projectOrder, ["/b"]);
  assert.deepEqual(next.pinnedProjectPaths, []);
  assert.deepEqual(next.sessionOrder, ["s2"]);
  assert.deepEqual(next.pinnedSessionIds, []);
});
