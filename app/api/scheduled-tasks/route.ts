import { NextResponse } from "next/server";
import { jsonError, resolveAllowedProject } from "@/lib/dev-server-api";
import { ensureScheduledTaskScheduler } from "@/lib/scheduled-task-scheduler";
import { isScheduledTasksEnabled } from "@/lib/scheduled-task-settings";
import { listScheduledTasks } from "@/lib/scheduled-tasks";
import type { ScheduledTaskListResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The bottom bar's task list: every session's tasks in this project directory. */
export async function GET(req: Request) {
  ensureScheduledTaskScheduler();
  const cwd = await resolveAllowedProject(new URL(req.url).searchParams.get("cwd"));
  if (cwd instanceof NextResponse) return cwd;
  try {
    return NextResponse.json({
      enabled: isScheduledTasksEnabled(),
      tasks: listScheduledTasks({ cwd }),
    } satisfies ScheduledTaskListResponse);
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
