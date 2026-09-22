import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getProjectActivity,
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
