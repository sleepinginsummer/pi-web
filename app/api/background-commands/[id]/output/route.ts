import { NextResponse } from "next/server";
import { jsonError, resolveAllowedProject } from "@/lib/dev-server-api";
import { getBackgroundCommand, readBackgroundCommandOutput } from "@/lib/background-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET ?lines= — a command's latest output for the list's expanded row. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const command = getBackgroundCommand(id);
  if (!command) return jsonError(404, "Command not found");
  const project = await resolveAllowedProject(command.cwd);
  if (project instanceof NextResponse) return project;
  const lines = Number(new URL(req.url).searchParams.get("lines")) || 200;
  return NextResponse.json({ command, lines: readBackgroundCommandOutput(id, { lines }) ?? [] });
}
