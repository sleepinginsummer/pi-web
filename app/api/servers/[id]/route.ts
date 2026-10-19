import { NextResponse } from "next/server";
import { jsonError, readMutationBody, resolveAllowedServer } from "@/lib/dev-server-api";
import { dismissDevServer, stopDevServer } from "@/lib/dev-server-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const server = await resolveAllowedServer(id);
  if (server instanceof NextResponse) return server;
  if (body.action === "stop") {
    return NextResponse.json({ server: await stopDevServer(id) });
  }
  if (body.action === "dismiss") {
    return dismissDevServer(id)
      ? NextResponse.json({ ok: true })
      : jsonError(409, "Stop the server before removing it");
  }
  return jsonError(400, 'action must be "stop" or "dismiss"');
}
