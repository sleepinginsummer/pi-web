import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { addWorktree, invalidateWorktreeListCache, listWorktrees, removeWorktree } = await jiti.import("./worktree.ts");
const { getRemoteOwner, getUpstreamDisplayBranch } = await jiti.import("./git-remote-display.ts");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("remote URL 仅转换界面 owner 标签", () => {
  assert.equal(getRemoteOwner("https://github.com/sleepinginsummer/pi-web.git"), "sleepinginsummer");
  assert.equal(getRemoteOwner("git@github.com:sleepinginsummer/pi-web.git"), "sleepinginsummer");
  assert.equal(getRemoteOwner("/local/repo.git"), null);
  assert.equal(
    getUpstreamDisplayBranch("fork/main", new Map([["fork", "git@github.com:sleepinginsummer/pi-web.git"]])),
    "sleepinginsummer/main",
  );
  assert.equal(getUpstreamDisplayBranch("origin/main", new Map()), "origin/main");
});
test("listWorktrees 返回带远程名前缀的 upstream", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-web-worktree-"));
  try {
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Pi Web Test");
    git(repo, "config", "user.email", "pi-web@example.invalid");
    git(repo, "commit", "--allow-empty", "-m", "init");
    git(repo, "remote", "add", "origin", "https://github.com/example-owner/repo.git");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "branch", "--set-upstream-to=origin/main", "main");

    const [worktree] = await listWorktrees(repo);
    assert.equal(worktree.branch, "main");
    assert.equal(worktree.upstreamBranch, "origin/main");
    assert.equal(worktree.upstreamDisplayBranch, "example-owner/main");

    git(repo, "branch", "--unset-upstream", "main");
    invalidateWorktreeListCache();
    const [withoutUpstream] = await listWorktrees(repo);
    assert.equal(withoutUpstream.branch, "main");
    assert.equal(withoutUpstream.upstreamBranch, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("创建和删除 worktree 后不会复用旧列表 Promise", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-web-worktree-cache-"));
  try {
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Pi Web Test");
    git(repo, "config", "user.email", "pi-web@example.invalid");
    git(repo, "commit", "--allow-empty", "-m", "init");

    const initial = await listWorktrees(repo);
    const created = await addWorktree(repo, "feature/cache-test");
    const afterCreate = await listWorktrees(repo);
    assert.equal(initial.length, 1);
    assert.equal(afterCreate.length, 2);
    assert.ok(afterCreate.some((worktree) => worktree.path === created.path));

    await removeWorktree(repo, created.path);
    const afterRemove = await listWorktrees(repo);
    assert.equal(afterRemove.length, 1);
    assert.ok(!afterRemove.some((worktree) => worktree.path === created.path));
  } finally {
    invalidateWorktreeListCache();
    rmSync(`${repo}-worktrees`, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
