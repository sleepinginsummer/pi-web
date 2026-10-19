import { NextResponse } from "next/server";
import { jsonError, readMutationBody } from "@/lib/dev-server-api";
import { isDevServersEnabled, writeDevServersEnabled } from "@/lib/dev-server-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Settings › General's dev server switch. Sessions pick it up on their next
// reload; running servers are left alone so none loses its owner.

export async function GET() {
  return NextResponse.json({ enabled: isDevServersEnabled() });
}

export async function PUT(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.enabled !== "boolean") return jsonError(400, "enabled must be a boolean");
  try {
    return NextResponse.json({ enabled: writeDevServersEnabled(body.enabled) });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
