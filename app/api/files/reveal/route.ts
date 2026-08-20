import { execFile } from "child_process";
import { stat } from "fs/promises";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRevealCommand } from "@/lib/file-reveal";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json() as { path?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.path, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const fileStats = await stat(body.path);
    const isDirectory = fileStats.isDirectory();
    const { command, args } = getRevealCommand(body.path, isDirectory);
    console.info("[files/reveal] 正在系统文件管理器中定位路径", { path: body.path, platform: process.platform });
    await execFileAsync(command, args, { timeout: 10_000, windowsHide: true });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[files/reveal] 定位路径失败", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
