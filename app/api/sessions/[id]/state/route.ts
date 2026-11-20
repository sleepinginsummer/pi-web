import { NextResponse } from "next/server";
import { getRpcSessionSnapshot } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 状态读取（挂载、每 15 秒的 reconcile）从不显示提示词：`systemPrompt` 几乎就是
    // 整份回复的大小，只在顶栏「系统」面板里按需单独读取。
    const snapshot = await getRpcSessionSnapshot(id);
    if (snapshot.alive) return NextResponse.json(snapshot);

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
