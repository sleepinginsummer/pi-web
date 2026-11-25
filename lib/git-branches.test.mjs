import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  authorizeGitBranchMutation,
  resolveGitWorktreeTopLevel,
  switchGitBranchSafely,
} = await jiti.import("./git-branches.ts");
const {
  allowFileRoot,
  getAdditionalAllowedRoots,
  getAdditionalGitMutationRoots,
  normalizeSlashes,
} = await jiti.import("./allowed-roots.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function createTempGitRepoWithSubdir() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-git-branch-auth-")));
  const subDir = join(repo, "packages", "sub");
  mkdirSync(subDir, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "root.txt"), "root-main\n");
  writeFileSync(join(subDir, "sub.txt"), "sub-main\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init main"]);
  git(repo, ["checkout", "-b", "feat"]);
  writeFileSync(join(repo, "root.txt"), "root-feat\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat commit"]);
  git(repo, ["checkout", "main"]);
  return { repo, subDir };
}

test("allowFileRoot (browsing worktrees) never expands Git mutation roots", () => {
  const fakeRepo = `/tmp/pi-web-browse-only-${Date.now()}`;
  allowFileRoot(fakeRepo);
  const key = normalizeSlashes(fakeRepo);
  assert.equal(getAdditionalAllowedRoots().has(key), true);
  assert.equal(getAdditionalGitMutationRoots().has(key), false);
  getAdditionalAllowedRoots().delete(key);
});

test("authorizeGitBranchMutation and switchGitBranchSafely share mutation roots isolated from browse roots", async () => {
  const { repo, subDir } = createTempGitRepoWithSubdir();
  try {
    const topLevel = await resolveGitWorktreeTopLevel(subDir);
    assert.equal(topLevel, repo);

    // 模拟 GET /api/worktrees 把主仓库顶层加入文件浏览白名单（browseRoots 包含 repo），
    // 但 Git 写操作白名单（mutationRoots）仍然只授权了子目录 subDir：
    const browseExpandedOptions = {
      getBrowseRoots: async () => new Set([subDir, repo]),
      getMutationRoots: async () => new Set([subDir]),
    };

    // GET 的 canSwitch 与 POST 必须一致拒绝，主仓库分支保持 main
    const canSwitchDenied = await authorizeGitBranchMutation(subDir, browseExpandedOptions);
    assert.equal(canSwitchDenied.ok, false);
    assert.equal(canSwitchDenied.status, 403);

    const denied = await switchGitBranchSafely(subDir, "feat", browseExpandedOptions);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.equal(git(repo, ["branch", "--show-current"]), "main");

    // 仅当真实工作树顶层本身处于 Git 写操作白名单内时，才允许切分支
    const authorizedOptions = {
      getBrowseRoots: async () => new Set([repo]),
      getMutationRoots: async () => new Set([repo]),
    };
    const canSwitchAllowed = await authorizeGitBranchMutation(subDir, authorizedOptions);
    assert.equal(canSwitchAllowed.ok, true);
    assert.equal(canSwitchAllowed.worktreeTopLevel, repo);

    const allowed = await switchGitBranchSafely(subDir, "feat", authorizedOptions);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.data.currentBranch, "feat");
    assert.equal(allowed.data.canSwitch, true);
    assert.equal(git(repo, ["branch", "--show-current"]), "feat");

    // 非法选项前缀与不存在分支分别返回 400 / 404
    const badName = await switchGitBranchSafely(subDir, "--force", authorizedOptions);
    assert.equal(badName.ok, false);
    assert.equal(badName.status, 400);

    const missing = await switchGitBranchSafely(subDir, "does-not-exist", authorizedOptions);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
