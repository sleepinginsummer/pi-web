import { NextResponse } from "next/server";
import { jsonError, readMutationBody, resolveAllowedProject } from "@/lib/dev-server-api";
import { ensureScheduledTaskScheduler, runScheduledTaskNow } from "@/lib/scheduled-task-scheduler";
import { isScheduledTasksEnabled } from "@/lib/scheduled-task-settings";
import { deleteScheduledTask, getScheduledTask, updateScheduledTask } from "@/lib/scheduled-tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS = new Set(["pause", "resume", "run", "delete"]);

/** The task list's buttons: { action: "pause" | "resume" | "run" | "delete" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return jsonError(400, "action must be pause, resume, run or delete");
  const task = getScheduledTask(id);
  if (!task) return jsonError(404, "Task not found");
  const project = await resolveAllowedProject(task.cwd);
  if (project instanceof NextResponse) return project;
  ensureScheduledTaskScheduler();
  try {
    switch (action) {
      case "delete":
        await deleteScheduledTask(id);
        return NextResponse.json({ deleted: true });
      case "pause":
      case "resume":
        return NextResponse.json({ task: await updateScheduledTask(id, { enabled: action === "resume" }) });
      case "run":
        if (!isScheduledTasksEnabled()) return jsonError(409, "Scheduled tasks are turned off in Settings › General");
        await runScheduledTaskNow(id);
        return NextResponse.json({ task: getScheduledTask(id) ?? null });
    }
    return jsonError(400, "Unknown action");
  } catch (error) {
    return jsonError(409, error instanceof Error ? error.message : String(error));
  }
}
