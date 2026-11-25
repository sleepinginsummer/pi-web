import { isAbsolute } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import {
  authorizeGitBranchMutation,
  extractGitErrorMessage,
  listLocalBranchesInDir,
  resolveGitWorktreeTopLevel,
  switchGitBranchSafely,
} from "@/lib/git-branches";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { updateCachedSessionProject } from "@/lib/session-reader";
import { invalidateProjectCache, resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 列出指定目录的本地 Git 分支与当前分支上下文，并标注是否获准切换整个工作树。 */
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || (!isAbsolute(cwd) && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    invalidateProjectCache(cwd);
    const project = await resolveProject(cwd);
    const worktreeTopLevel = await resolveGitWorktreeTopLevel(cwd);
    const isGit = Boolean(worktreeTopLevel || project.branch || project.headCommit || project.isWorktree || project.isTopLevel);
    if (!isGit) {
      return NextResponse.json({
        isGit: false,
        projectRoot: project.projectRoot,
        currentBranch: null,
        isWorktree: false,
        branches: [],
        canSwitch: false,
      });
    }
    // canSwitch 与 POST 共用同一套 Git 写操作授权核验，不受浏览白名单扩张影响
    const mutationAuth = await authorizeGitBranchMutation(cwd);
    const canSwitch = mutationAuth.ok;
    const currentBranch = project.branch ?? (project.headCommit ? `detached@${project.headCommit}` : null);
    const branches = canSwitch && worktreeTopLevel ? await listLocalBranchesInDir(worktreeTopLevel) : (currentBranch ? [currentBranch] : []);
    if (project.branch && !branches.includes(project.branch)) {
      branches.unshift(project.branch);
    }
    updateCachedSessionProject(cwd, project, currentBranch);
    return NextResponse.json({
      isGit: true,
      projectRoot: project.projectRoot,
      currentBranch,
      isWorktree: project.isWorktree,
      branches,
      canSwitch,
    });
  } catch (error) {
    return NextResponse.json({ error: extractGitErrorMessage(error) }, { status: 500 });
  }
}

/** 在已授权的真实 Git 工作树顶层目录执行原地分支切换。 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { cwd?: unknown; branch?: unknown };
  try {
    body = await request.json() as { cwd?: unknown; branch?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const branch = typeof body.branch === "string" ? body.branch : "";
  const outcome = await switchGitBranchSafely(cwd, branch);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json(outcome.data);
}
