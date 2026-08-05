import { isAbsolute } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { invalidateProjectCache, resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

// 返回指定工作目录的实时 Git 上下文，仅允许查询已授权的会话目录。
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || !isAbsolute(cwd)) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    invalidateProjectCache(cwd);
    invalidateSessionListCache();
    const project = await resolveProject(cwd);
    return NextResponse.json({
      projectRoot: project.projectRoot,
      currentBranch: project.branch ?? (project.headCommit ? `detached@${project.headCommit}` : null),
      isWorktree: project.isWorktree,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
