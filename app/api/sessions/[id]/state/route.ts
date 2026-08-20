import { NextResponse } from "next/server";
import { getRpcSessionSnapshot } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json(await getRpcSessionSnapshot(id));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
