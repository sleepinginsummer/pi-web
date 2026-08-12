import { statSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@/lib/session-reader";
import { assertTrashFileName, getTrashDir } from "@/lib/trash";

// GET /api/trash/[name]/content — 读取回收站会话的完整对话内容（详情弹窗用）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  try {
    assertTrashFileName(name);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
  const filePath = join(getTrashDir(), name);
  try {
    statSync(filePath);
  } catch {
    return NextResponse.json({ error: "Trash session not found" }, { status: 404 });
  }
  try {
    // 回收站文件是完整会话文件，与正常会话走同一套上下文构建逻辑
    const sm = SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never);
    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
