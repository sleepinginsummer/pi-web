import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { emptySidebarPreferences, orderProjectsByPreference, reduceSidebarPreferences, rebaseSidebarPreferenceAction } = await createJiti(import.meta.url).import("./sidebar-preference-state.ts");
const {
  getProjectActivity,
  groupSidebarProjects,
  resolveSidebarProjectMove,
  expandSidebarProject,
  getRecentProjects,
  resolveSidebarProjectPath,
  sessionsForProject,
  sidebarProjectPath,
} = await createJiti(import.meta.url).import("./project-groups.ts");

function session(id, cwd, projectRoot, modified, isWorktree = false) {
  return {
    id,
    path: `${id}.jsonl`,
    cwd,
    projectRoot,
    isWorktree,
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
  };
}

const main = session("main", "/repo", "/repo", "2026-08-12T00:00:00.000Z");
const worktree = session("worktree", "/repo-worktrees/feature", "/repo", "2026-08-13T00:00:00.000Z", true);

test("主仓库与 worktree 归属不同的侧边栏项目行", () => {
  assert.equal(sidebarProjectPath(main), "/repo");
  assert.equal(sidebarProjectPath(worktree), "/repo-worktrees/feature");
});

test("最近项目保留独立 worktree 行并按活动排序", () => {
  assert.deepEqual(getRecentProjects([main, worktree]), ["/repo-worktrees/feature", "/repo"]);
});

test("无会话 worktree 仍解析为独立侧边栏项目行", () => {
  const worktrees = [
    { path: "/repo", isMain: true },
    { path: "/repo-worktrees/new", isMain: false },
  ];
  assert.equal(resolveSidebarProjectPath([], "/repo-worktrees/new", { projectRoot: "/repo", worktrees }), "/repo-worktrees/new");
  assert.equal(resolveSidebarProjectPath([], "/repo", { projectRoot: "/repo", worktrees }), "/repo");
  assert.equal(resolveSidebarProjectPath([worktree], worktree.cwd, { projectRoot: "/repo" }), worktree.cwd);
});

test("Windows 路径变体不会重复分组或漏掉筛选与统计", () => {
  const first = session("windows-a", "D:\\Repo-Worktrees\\Feature", "D:\\Repo", "2026-08-14T00:00:00.000Z", true);
  const second = session("windows-b", "d:/repo-worktrees/feature", "d:/repo", "2026-08-15T00:00:00.000Z", true);
  assert.deepEqual(getRecentProjects([first, second]), ["D:\\Repo-Worktrees\\Feature"]);
  assert.deepEqual(sessionsForProject([first, second], "d:/REPO-WORKTREES/feature").map((item) => item.id), ["windows-a", "windows-b"]);

  const activity = getProjectActivity([first, second], new Set([first.id, second.id]), new Set([second.id]));
  assert.deepEqual(activity.get("d:/REPO-WORKTREES/feature"), { running: 2, unread: 1 });
  assert.equal(activity.hasActivityOutside("d:/repo-worktrees/FEATURE"), false);
  assert.equal(resolveSidebarProjectPath([], "d:/repo-worktrees/NEW", {
    projectRoot: "D:\\Repo",
    worktrees: [{ path: "D:\\Repo-Worktrees\\New", isMain: false }],
  }), "D:\\Repo-Worktrees\\New");
});

test("项目筛选不会跨主仓库和 worktree 边界", () => {
  const sessions = [main, worktree];
  assert.deepEqual(sessionsForProject(sessions, "/repo").map((item) => item.id), ["main"]);
  assert.deepEqual(sessionsForProject(sessions, "/repo-worktrees/feature").map((item) => item.id), ["worktree"]);
});

test("运行和未读统计使用同一侧边栏项目身份", () => {
  const activity = getProjectActivity(
    [main, worktree],
    new Set(["main", "worktree"]),
    new Set(["worktree"]),
  );
  assert.deepEqual(activity.get("/repo"), { running: 1, unread: 0 });
  assert.deepEqual(activity.get("/repo-worktrees/feature"), { running: 1, unread: 1 });
});


test("worktree 在原项目下分组，并保留 checkout 顺序与会话边界", () => {
  assert.deepEqual(groupSidebarProjects([worktree.cwd, "/other", main.cwd], [main, worktree]), [
    { path: "/repo", worktrees: [worktree.cwd] },
    { path: "/other", worktrees: [] },
  ]);
  assert.deepEqual(groupSidebarProjects([worktree.cwd], [worktree]), [
    { path: "/repo", worktrees: [worktree.cwd] },
  ]);
});

test("未发送消息的 worktree 使用 checkout 元数据嵌入主项目", () => {
  assert.deepEqual(groupSidebarProjects(["/repo-worktrees/new", "/repo"], [], {
    projectRoot: "/repo",
    worktrees: [{ path: "/repo", isMain: true }, { path: "/repo-worktrees/new", isMain: false }],
  }), [{ path: "/repo", worktrees: ["/repo-worktrees/new"] }]);
});

test("嵌套分组复用 Windows 路径身份，普通子目录保持原归属", () => {
  const windows = session("windows", "D:\\Repo-Worktrees\\Feature", "D:\\Repo", main.modified, true);
  assert.deepEqual(groupSidebarProjects(["d:/repo-worktrees/feature", "d:/REPO", "/other/sub"], [windows]), [
    { path: "D:\\Repo", worktrees: ["d:/repo-worktrees/feature"] },
    { path: "/other/sub", worktrees: [] },
  ]);
});


function orderedGroups(state, sessions, projects = state.projectOrder) {
  return groupSidebarProjects(
    orderProjectsByPreference(projects, state.projectOrder), sessions, null,
    (paths) => orderProjectsByPreference(paths, state.projectOrder),
  );
}

function moveGroup(state, groups, source, target) {
  const move = resolveSidebarProjectMove(groups, source, target);
  assert.ok(move);
  const action = { type: "move_project", ...move };
  const optimistic = reduceSidebarPreferences(state, action, false);
  const persisted = reduceSidebarPreferences(state, rebaseSidebarPreferenceAction(state, action), true);
  assert.deepEqual(optimistic.projectOrder, persisted.projectOrder);
  return persisted;
}

test("父项目移动不再被排在前面的 worktree 抢占位置，组内顺序保持", () => {
  const second = session("second", "/repo-worktrees/second", "/repo", main.modified, true);
  const sessions = [main, worktree, second];
  const state = { ...emptySidebarPreferences(), projectOrder: [worktree.cwd, main.cwd, second.cwd, "/other"] };
  const next = moveGroup(state, orderedGroups(state, sessions), "/repo", "/other");
  assert.deepEqual(orderedGroups(next, sessions), [
    { path: "/other", worktrees: [] },
    { path: "/repo", worktrees: [worktree.cwd, second.cwd] },
  ]);
  assert.deepEqual(orderedGroups(state, sessions)[0].worktrees, orderedGroups(next, sessions)[1].worktrees);
});

test("只有 worktree 的虚拟父目录可以排序，并在重读偏好后保持位置", () => {
  const state = { ...emptySidebarPreferences(), projectOrder: [worktree.cwd, "/other"] };
  const projects = [worktree.cwd, "/other"];
  const next = moveGroup(state, orderedGroups(state, [worktree], projects), "/repo", "/other");
  assert.deepEqual(orderedGroups(next, [worktree], projects).map((group) => group.path), ["/other", "/repo"]);
  assert.ok(next.projectOrder.includes("/repo"));
});

test("worktree 只在同组内移动，父组可拖到另一组的子目录", () => {
  const groups = [{ path: "/a", worktrees: ["/a-1", "/a-2"] }, { path: "/b", worktrees: ["/b-1"] }];
  assert.deepEqual(resolveSidebarProjectMove(groups, "/a-2", "/a-1"), { source: "/a-2", target: "/a-1", visibleIds: ["/a-1", "/a-2"] });
  assert.deepEqual(resolveSidebarProjectMove(groups, "/a", "/b-1"), { source: "/a", target: "/b", visibleIds: ["/a", "/b"] });
  assert.equal(resolveSidebarProjectMove(groups, "/a-1", "/b-1"), null);
  assert.equal(resolveSidebarProjectMove(groups, "/a-1", "/a"), null);
});

test("Windows 等价路径定位使用实际父组与子目录键，重复定位仍可重新展开", () => {
  const groups = [{ path: "d:/repo", worktrees: ["d:/repo-worktrees/feature"] }];
  const target = "D:/REPO-WORKTREES/Feature".replaceAll("/", "\\");
  const collapsed = new Set(["d:/repo", "d:/repo-worktrees/feature", "/unrelated"]);
  const expanded = expandSidebarProject(groups, collapsed, target);
  assert.deepEqual([...expanded], ["/unrelated"]);
  assert.deepEqual([...collapsed], ["d:/repo", "d:/repo-worktrees/feature", "/unrelated"]);
  expanded.add("d:/repo");
  assert.deepEqual([...expandSidebarProject(groups, expanded, target)], ["/unrelated"]);
  assert.equal(expandSidebarProject(groups, expanded, "/missing"), expanded);
});
