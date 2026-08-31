import { NextResponse } from "next/server";
import { getRpcSessionSnapshot } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
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
