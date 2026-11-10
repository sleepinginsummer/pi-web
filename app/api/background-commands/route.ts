import { NextResponse } from "next/server";
import { jsonError, resolveAllowedProject } from "@/lib/dev-server-api";
import { listBackgroundCommands } from "@/lib/background-commands";
import { isBackgroundCommandsEnabled } from "@/lib/background-command-settings";
import type { BackgroundCommandListResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The bottom bar's list: every session's background commands in this project directory. */
export async function GET(req: Request) {
  const cwd = await resolveAllowedProject(new URL(req.url).searchParams.get("cwd"));
  if (cwd instanceof NextResponse) return cwd;
  try {
    return NextResponse.json({
      enabled: isBackgroundCommandsEnabled(),
      commands: listBackgroundCommands({ cwd }),
    } satisfies BackgroundCommandListResponse);
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
