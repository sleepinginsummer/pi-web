import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  getAllowedFileRoots,
  getAllowedGitMutationRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./file-access";
import { toNativePath } from "./paths";
import { updateCachedSessionProject } from "./session-reader";
import { invalidateProjectCache, invalidateWorktreeListCache, resolveProject } from "./worktree";

const execFileAsync = promisify(execFile);

export async function runGitInDir(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

export function extractGitErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr.trim().split("\n")[0] ?? stderr.trim();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return String(error);
}

function isAbsoluteAnyPlatform(target: string): boolean {
  return isAbsolute(target) || isWindowsAbsolutePath(target);
}

function realPathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

export async function listLocalBranchesInDir(cwd: string): Promise<string[]> {
  try {
    const output = await runGitInDir(cwd, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=-committerdate",
      "refs/heads",
    ]);
    if (!output) return [];
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 解析当前路径所属 Git 工作树的真实顶层目录（符号链接归一）。非 Git 目录返回 null。 */
export async function resolveGitWorktreeTopLevel(cwd: string): Promise<string | null> {
  try {
    const raw = await runGitInDir(cwd, ["rev-parse", "--show-toplevel"]);
    if (!raw) return null;
    return realPathOrSelf(toNativePath(raw));
  } catch {
    return null;
  }
}

export type SwitchBranchOutcome =
  | {
      ok: true;
      data: {
        isGit: true;
        projectRoot: string;
        currentBranch: string;
        isWorktree: boolean;
        branches: string[];
        canSwitch: true;
      };
    }
  | { ok: false; status: number; error: string };

export type AuthorizeGitMutationResult =
  | { ok: true; worktreeTopLevel: string }
  | { ok: false; status: number; error: string; worktreeTopLevel: string | null };

export interface GitMutationAuthOptions {
  /** 文件浏览白名单（仅用于确认 cwd 可访问）。 */
  getBrowseRoots?: () => Promise<Set<string>>;
  /** Git 写操作白名单（与文件浏览白名单隔离，禁止通过 GET /api/worktrees 等浏览行为提权）。 */
  getMutationRoots?: () => Promise<Set<string>>;
}

/**
 * 统一的 Git 分支修改权限核验（供 GET 的 canSwitch 与 POST 的实际切换共同调用）：
 * 1. 先校验传入 cwd 获准访问；
 * 2. 解析当前 Git 工作树的真实顶层目录（`--show-toplevel`）；
 * 3. 使用独立的 Git 写操作白名单校验该顶层目录，确保只获准访问子目录（即使已浏览 worktree 列表）
 *    无法修改未授权的父工作树。
 */
export async function authorizeGitBranchMutation(
  rawCwd: string,
  options: GitMutationAuthOptions = {},
): Promise<AuthorizeGitMutationResult> {
  const cwd = rawCwd.trim();
  if (!cwd || !isAbsoluteAnyPlatform(cwd)) {
    return { ok: false, status: 400, error: "cwd must be an absolute path", worktreeTopLevel: null };
  }
  const getBrowseRoots = options.getBrowseRoots ?? getAllowedFileRoots;
  const getMutationRoots = options.getMutationRoots ?? getAllowedGitMutationRoots;

  const browseRoots = await getBrowseRoots();
  if (!isFilePathAllowed(cwd, browseRoots) || !isExistingFilePathAllowed(cwd, browseRoots)) {
    return { ok: false, status: 403, error: "Access denied", worktreeTopLevel: null };
  }

  const worktreeTopLevel = await resolveGitWorktreeTopLevel(cwd);
  if (!worktreeTopLevel) {
    return { ok: false, status: 400, error: "Not a git repository", worktreeTopLevel: null };
  }

  const mutationRoots = await getMutationRoots();
  if (!isFilePathAllowed(worktreeTopLevel, mutationRoots) || !isExistingFilePathAllowed(worktreeTopLevel, mutationRoots)) {
    return {
      ok: false,
      status: 403,
      error: "Access denied: git worktree root is not authorized for Git mutations",
      worktreeTopLevel,
    };
  }

  return { ok: true, worktreeTopLevel };
}

/**
 * 核验并执行本地 Git 分支切换：
 * 复用 `authorizeGitBranchMutation` 确保 GET `canSwitch` 与 POST 切换口径完全一致，
 * 并从已校验的真实工作树顶层目录执行 `git switch -- <branch>`。
 */
export async function switchGitBranchSafely(
  rawCwd: string,
  rawBranch: string,
  options: GitMutationAuthOptions = {},
): Promise<SwitchBranchOutcome> {
  const cwd = rawCwd.trim();
  const branch = rawBranch.trim();

  const auth = await authorizeGitBranchMutation(cwd, options);
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error };
  }
  const { worktreeTopLevel } = auth;

  // 禁止选项注入与非法分支名
  if (!branch || branch.startsWith("-")) {
    return { ok: false, status: 400, error: "Invalid branch name" };
  }
  try {
    await runGitInDir(worktreeTopLevel, ["check-ref-format", "--branch", branch]);
  } catch {
    return { ok: false, status: 400, error: "Invalid branch name" };
  }

  const existingBranches = await listLocalBranchesInDir(worktreeTopLevel);
  if (!existingBranches.includes(branch)) {
    return { ok: false, status: 404, error: `Branch not found: ${branch}` };
  }

  try {
    await runGitInDir(worktreeTopLevel, ["switch", "--", branch], 15_000);
  } catch (error) {
    const message = extractGitErrorMessage(error);
    const conflict = /would be overwritten|unmerged|already used by worktree|local changes/i.test(message);
    return { ok: false, status: conflict ? 409 : 400, error: message };
  }

  invalidateProjectCache(cwd);
  invalidateProjectCache(worktreeTopLevel);
  invalidateWorktreeListCache();
  const project = await resolveProject(cwd);
  const currentBranch = project.branch ?? (project.headCommit ? `detached@${project.headCommit}` : branch);
  updateCachedSessionProject(cwd, project, currentBranch);
  const branches = await listLocalBranchesInDir(worktreeTopLevel);

  return {
    ok: true,
    data: {
      isGit: true,
      projectRoot: project.projectRoot,
      currentBranch,
      isWorktree: project.isWorktree,
      branches,
      canSwitch: true,
    },
  };
}
