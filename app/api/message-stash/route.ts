import { NextResponse } from "next/server";
import { jsonError, readMutationBody, resolveAllowedProject } from "@/lib/dev-server-api";
import { checkStashTarget, resolveStashProject } from "@/lib/message-stash-delivery";
import {
  changeStashedMessage, claimStashedMessage, finishStashedMessage, listStashedMessages,
  loadStashedContent, parseStashedContent, saveStashedMessage, StashError,
} from "@/lib/message-stash";
import { isScheduledTasksEnabled } from "@/lib/scheduled-task-settings";
import { ensureScheduledTaskScheduler } from "@/lib/scheduled-task-scheduler";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const cwd = await resolveAllowedProject(body.cwd);
  if (cwd instanceof NextResponse) return cwd;

  try {
    const project = await resolveStashProject(cwd);
    const { action, id, revision } = body;
    if (action === "list") {
      return NextResponse.json({ items: listStashedMessages(project), schedulingEnabled: isScheduledTasksEnabled() });
    }
    if (action === "create") {
      const draft = parseStashedContent(body.text, body.images);
      return NextResponse.json(await saveStashedMessage(project, draft));
    }
    if (typeof id !== "string") return jsonError(400, "Draft id required");
    if (action === "finish") {
      if (typeof body.token !== "string" || typeof body.sent !== "boolean") return jsonError(400, "Invalid delivery result");
      await finishStashedMessage(project, id, body.token, body.sent);
      return NextResponse.json({ success: true });
    }
    if (typeof revision !== "string") return jsonError(400, "Draft revision required");
    switch (action) {
      case "load":
        return NextResponse.json(await loadStashedContent(project, id, revision));
      case "setMode":
        if (body.mode !== "steer" && body.mode !== "followUp") return jsonError(400, "Invalid stash send mode");
        await changeStashedMessage(project, id, revision, body.mode);
        break;
      case "edit":
        return NextResponse.json(await saveStashedMessage(project, parseStashedContent(body.text, body.images), { id, revision }));
      case "claim":
        return NextResponse.json(await claimStashedMessage(project, id, revision));
      case "delete":
      case "recover":
      case "cancelSchedule":
        await changeStashedMessage(project, id, revision, action === "cancelSchedule" ? null : action);
        break;
      case "schedule": {
        if (!isScheduledTasksEnabled()) return jsonError(409, "Scheduled tasks are disabled");
        const { at, sessionId, label } = body;
        if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= Date.now() || at > 8.64e15 || typeof sessionId !== "string" || !sessionId) {
          return jsonError(400, "Choose a future date and a saved session");
        }
        await checkStashTarget(project, sessionId);
        await changeStashedMessage(project, id, revision, { at, sessionId, label: typeof label === "string" ? label.slice(0, 160) : sessionId });
        ensureScheduledTaskScheduler();
        break;
      }
      default:
        return jsonError(400, "Unknown stash action");
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StashError) return jsonError(error.status, error.message);
    console.warn("[pi-web] 暂存库请求失败", { action: body.action, error });
    return jsonError(500, "Message stash is unavailable");
  }
}
