import { NextResponse } from "next/server";
import { jsonError, readMutationBody, resolveAllowedProject } from "@/lib/dev-server-api";
import { dismissBackgroundCommand, getBackgroundCommand, stopBackgroundCommand } from "@/lib/background-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The list's buttons: { action: "stop" | "dismiss" }. A user's stop still wakes the session. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const command = getBackgroundCommand(id);
  if (!command) return jsonError(404, "Command not found");
  const project = await resolveAllowedProject(command.cwd);
  if (project instanceof NextResponse) return project;
  if (body.action === "stop") return NextResponse.json({ command: stopBackgroundCommand(id, "user") });
  if (body.action === "dismiss") {
    return dismissBackgroundCommand(id)
      ? NextResponse.json({ dismissed: true })
      : jsonError(409, "A running command cannot be dismissed");
  }
  return jsonError(400, "action must be stop or dismiss");
}
