import { NextResponse } from "next/server";
import { restoreTrashedSession } from "@/lib/trash";
import { updateSessionTitleTaskPath } from "@/lib/session-file-title";
import { cacheSessionPath, invalidateSessionListCache } from "@/lib/session-reader";

// POST /api/trash/[name] — 恢复回收站中的会话到原 cwd
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  try {
    const { restoredPath, sessionId } = restoreTrashedSession(name);
    // rename 后迁移可能仍在执行的标题任务，再重建会话路径缓存。
    updateSessionTitleTaskPath(sessionId, restoredPath);
    cacheSessionPath(sessionId, restoredPath);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, path: restoredPath });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
