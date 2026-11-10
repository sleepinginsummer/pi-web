import { NextResponse } from "next/server";
import { jsonError, readMutationBody } from "@/lib/dev-server-api";
import { isScheduledTasksEnabled, writeScheduledTasksEnabled } from "@/lib/scheduled-task-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Settings › General's scheduled task switch. The scheduler reads it on every
// tick; sessions add or drop the tools on their next reload.

export async function GET() {
  return NextResponse.json({ enabled: isScheduledTasksEnabled() });
}

export async function PUT(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.enabled !== "boolean") return jsonError(400, "enabled must be a boolean");
  try {
    return NextResponse.json({ enabled: writeScheduledTasksEnabled(body.enabled) });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
