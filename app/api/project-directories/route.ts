import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { removeSidebarPreferenceIds } from "@/lib/sidebar-preferences";
import {
  addProjectDirectory,
  normalizeProjectDirectory,
  readProjectDirectories,
  removeProjectDirectory,
} from "@/lib/project-directories";

export const dynamic = "force-dynamic";

export async function GET() {
  const projects = readProjectDirectories();
  projects.forEach(allowFileRoot);
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cwd?: unknown };
    const cwd = normalizeProjectDirectory(body.cwd);
    allowFileRoot(cwd);
    return NextResponse.json({ projects: await addProjectDirectory(cwd), cwd });
  } catch (error) {
    console.error("保存 Pi Web 项目目录失败", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    const cwd = body.cwd.trim();
    const projects = await removeProjectDirectory(cwd);
    try {
      await removeSidebarPreferenceIds({ projectPaths: [cwd] });
    } catch (error) {
      console.error("清理已删除项目的侧边栏偏好失败", error);
    }
    return NextResponse.json({ projects });
  } catch (error) {
    console.error("移除 Pi Web 项目目录失败", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
