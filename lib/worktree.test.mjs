import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { addWorktree, invalidateWorktreeListCache, listWorktrees, removeWorktree } = await jiti.import("./worktree.ts");
const { getRemoteOwner, getUpstreamDisplayBranch } = await jiti.import("./git-remote-display.ts");

const execFileAsync = promisify(execFile);

async function loadSubject() {
  return jiti.import("./worktree.ts");
}


function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args.flat()], { encoding: "utf8" }).trim();
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

test("a removed worktree resolves back to the repo it branched from", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-removed-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);

  const { inferRemovedWorktree } = await loadSubject();

  // addWorktree() places worktrees in `<repoRoot>-worktrees/<branch>`, and a finished
  // subagent run removes that directory while its session file still records it as the cwd.
  const removed = inferRemovedWorktree(path.join(`${repo}-worktrees`, "pi-web-agent-abc"));
  assert.equal(removed?.projectRoot, realpathSync(repo));

  // A cwd that is gone for any other reason has no repo to fall back to.
  assert.equal(inferRemovedWorktree(path.join(tempRoot, "not-a-worktree-dir")), null);
  assert.equal(inferRemovedWorktree(path.join(`${tempRoot}-worktrees`, "orphan")), null);
});

test("recognizes submodule and dirty-worktree removal errors as forceable", async () => {
  const { worktreeRemovalRequiresForce } = await loadSubject();

  assert.equal(worktreeRemovalRequiresForce("fatal: working trees containing submodules cannot be moved or removed"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: worktree is dirty"), true);
  // A locked worktree needs `remove -f -f`; a single force would still fail.
  assert.equal(worktreeRemovalRequiresForce("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"), false);
  assert.equal(worktreeRemovalRequiresForce("fatal: unrelated git failure"), false);
});

test("tells files a worktree still holds from submodules it contains", async () => {
  const { worktreeHasUncommittedFiles } = await loadSubject();

  assert.equal(worktreeHasUncommittedFiles("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeHasUncommittedFiles("fatal: worktree is dirty"), true);
  assert.equal(worktreeHasUncommittedFiles("fatal: working trees containing submodules cannot be moved or removed"), false);
  assert.equal(worktreeHasUncommittedFiles("fatal: unrelated git failure"), false);
});

test("forced worktree removal passes Git's force flag", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-force-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/force", linked]);
  await writeFile(path.join(linked, "untracked.txt"), "discard me\n");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, linked, true);
  assert.equal(existsSync(linked), false);
});

test("worktree removal accepts a path that runs through a link", async (t) => {
  // Git lists worktrees by their real path; macOS's tmpdir is a link to /private/var.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-link-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const alias = path.join(tempRoot, "alias");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/link", path.join(tempRoot, "linked")]);
  await symlink(tempRoot, alias, "dir");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, path.join(alias, "linked"));
  assert.equal(existsSync(path.join(tempRoot, "linked")), false);
});

test("worktrees of bare clones group under their clone, not the folder holding them (#1049)", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-bare-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, "source");
  await execFileAsync("git", ["init", source]);
  await git(source, ["config", "user.name", "Pi Web Test"]);
  await git(source, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(source, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(source, "README.md"), "# test\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "initial"]);

  // parent/repo1.git/worktree1 and parent/repo2.git/worktree1
  const parent = path.join(tempRoot, "parent");
  for (const name of ["repo1.git", "repo2.git"]) {
    await git(tempRoot, ["clone", "--bare", source, path.join(parent, name)]);
    await git(path.join(parent, name), ["worktree", "add", "-b", "worktree1", path.join(parent, name, "worktree1")]);
  }
  // The `.bare` layout: project/.git is a file pointing at project/.bare.
  const project = path.join(tempRoot, "project");
  await git(tempRoot, ["clone", "--bare", source, path.join(project, ".bare")]);
  await writeFile(path.join(project, ".git"), "gitdir: ./.bare\n");
  await git(project, ["worktree", "add", "-b", "feature", path.join(project, "feature")]);

  const { addWorktree, invalidateProjectCache, resolveProject } = await loadSubject();
  for (const name of ["repo1.git", "repo2.git"]) {
    const clone = path.join(parent, name);
    const linked = await resolveProject(path.join(clone, "worktree1"));
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.projectRoot, clone);
    assert.equal((await resolveProject(clone)).projectRoot, clone);
  }
  assert.equal((await resolveProject(path.join(project, "feature"))).projectRoot, project);

  // A new worktree goes to that clone, beside it.
  const created = await addWorktree(path.join(parent, "repo1.git"), "created");
  assert.equal(created.path, path.join(parent, "repo1.git-worktrees", "created"));
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));

  // Its sessions stay in that project once the folder is gone.
  await rm(created.path, { recursive: true, force: true });
  invalidateProjectCache();
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));
});
