import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { projectSessionTree } from "@/lib/session-tree-projection";

/** 返回分支导航和文件元数据，不读取或构建消息 context。 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    return NextResponse.json({
      sessionId: id,
      filePath,
      leafId: sm.getLeafId(),
      tree: projectSessionTree(sm.getTree()),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
