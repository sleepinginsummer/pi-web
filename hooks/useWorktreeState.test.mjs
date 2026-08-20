import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { appendCreatedWorktree, parseWorktreeState } = await jiti.import("./useWorktreeState.ts");
const {
  WorktreeMutationError,
  createWorktreeRequest,
  removeWorktreeRequest,
} = await jiti.import("../lib/worktree-client.ts");

test("parseWorktreeState 只提交完整的活动项目快照", () => {
  assert.deepEqual(parseWorktreeState("/repo", {
    projectRoot: "/repo",
    isGit: true,
    isTopLevel: true,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
  }), {
    forCwd: "/repo",
    projectRoot: "/repo",
    isGit: true,
    isTopLevel: true,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
  });
  assert.throws(() => parseWorktreeState("/repo", {}), /missing projectRoot/);
});

test("appendCreatedWorktree 乐观追加且不制造重复项", () => {
  const snapshot = {
    forCwd: "/repo",
    projectRoot: "/repo",
    isGit: true,
    isTopLevel: true,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
  };
  const created = { path: "/repo-wt", branch: "feature", isMain: false };
  const next = appendCreatedWorktree(snapshot, created);

  assert.equal(next.forCwd, "/repo-wt");
  assert.deepEqual(next.worktrees, [...snapshot.worktrees, created]);
  assert.equal(appendCreatedWorktree(next, created), next);
  assert.equal(appendCreatedWorktree(null, created), null);
});

test("createWorktreeRequest 统一创建协议并返回领域对象", async () => {
  let request;
  const created = await createWorktreeRequest("/repo", "feature", async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ path: "/repo-wt" }), { status: 200 });
  });

  assert.equal(request.url, "/api/worktrees");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { cwd: "/repo", branch: "feature" });
  assert.deepEqual(created, { path: "/repo-wt", branch: "feature", isMain: false });
});

test("removeWorktreeRequest 保留脏目录确认信号", async () => {
  await assert.rejects(
    removeWorktreeRequest("/repo", "/repo-wt", false, async () => (
      new Response(JSON.stringify({ error: "dirty", dirty: true }), { status: 409 })
    )),
    (error) => error instanceof WorktreeMutationError && error.dirty === true,
  );
});
