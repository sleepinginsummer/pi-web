import { NextResponse } from "next/server";
import { resolveAllowedServer } from "@/lib/dev-server-api";
import { readDevServerLogs } from "@/lib/dev-server-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = await resolveAllowedServer(id);
  if (server instanceof NextResponse) return server;
  const lines = Number(new URL(req.url).searchParams.get("lines") ?? 300);
  return NextResponse.json({ server, lines: readDevServerLogs(id, { lines: Number.isFinite(lines) ? lines : 300 }) ?? [] });
}
