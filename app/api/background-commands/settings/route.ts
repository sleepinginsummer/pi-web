import { NextResponse } from "next/server";
import { jsonError, readMutationBody } from "@/lib/dev-server-api";
import { isBackgroundCommandsEnabled, writeBackgroundCommandsEnabled } from "@/lib/background-command-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Settings › General's background command switch. Sessions add or drop the
// tool on their next reload; running commands are left alone.

export async function GET() {
  return NextResponse.json({ enabled: isBackgroundCommandsEnabled() });
}

export async function PUT(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.enabled !== "boolean") return jsonError(400, "enabled must be a boolean");
  try {
    return NextResponse.json({ enabled: writeBackgroundCommandsEnabled(body.enabled) });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
