import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { recordSessionRead } from "@/lib/session-read-receipts";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await resolveSessionPath(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  try {
    return NextResponse.json({ readAt: await recordSessionRead(id) });
  } catch (error) {
    console.error(`[pi-web] 记录会话 ${id} 已读失败`, error);
    return NextResponse.json({ error: "Could not record the session read" }, { status: 500 });
  }
}
