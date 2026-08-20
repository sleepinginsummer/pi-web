import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const value = Number(url.searchParams.get("messageLimit"));
  const maxMessages = Number.isSafeInteger(value) && value > 0 ? Math.min(value, 200) : undefined;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const sm = SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never, leafId, {
      deferThinking,
      deferToolResultImages,
      maxMessages,
    });
    return NextResponse.json({ context, leafId: leafId ?? sm.getLeafId() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
