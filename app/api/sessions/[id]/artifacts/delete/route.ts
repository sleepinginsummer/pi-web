import { execFile } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { samePath } from "@/lib/paths";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { verifySessionArtifactForDeletion } from "@/lib/session-artifacts-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

/** macOS 优先通过 Finder 移入废纸篓（argv 传参避免注入），失败时由调用方回退到 unlink。 */
async function moveFileToMacTrash(filePath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'tell application "Finder" to delete POSIX file (item 1 of argv)',
        "-e",
        "end run",
        "--",
        filePath,
      ],
      { timeout: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 安全删除单个会话产物文件：确认会话存在，并由服务端核验目标确为本会话成功写出的真实本地文件。 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await context.params;
  let body: { filePath?: unknown };
  try {
    body = await request.json() as { filePath?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawPath = typeof body.filePath === "string" ? body.filePath : "";
  const verified = await verifySessionArtifactForDeletion(id, rawPath);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  const targetPath = verified.resolvedPath;
  // 删除前再次确认目标仍为普通文件且真实路径未发生偏移，收窄竞态窗口
  try {
    const finalStat = await lstat(targetPath);
    if (!finalStat.isFile()) {
      return NextResponse.json({ error: "Only regular files can be deleted" }, { status: 400 });
    }
    const finalReal = await realpath(targetPath);
    if (!samePath(finalReal, targetPath)) {
      return NextResponse.json({ error: "Access denied: target path changed before deletion" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const trashed = await moveFileToMacTrash(targetPath);
  if (!trashed) {
    try {
      await unlink(targetPath);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ deleted: true, trashed, filePath: targetPath });
}
