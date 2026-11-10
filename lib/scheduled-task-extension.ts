import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { nextCronFires } from "./cron-schedule";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  type ScheduleInput,
} from "./scheduled-tasks";
import type { ScheduledTask } from "./types";

export const HOST_SCHEDULED_TASK_EXTENSION_NAME = "pi-web-scheduled-tasks";
export const SCHEDULED_TASK_TOOL_NAMES = ["schedule_create", "schedule_list", "schedule_update", "schedule_delete"] as const;

function text(content: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: content }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

function when(ms: number | null | undefined): string {
  return ms == null ? "—" : new Date(ms).toLocaleString();
}

export function describeTask(task: ScheduledTask): string {
  const schedule = task.schedule.kind === "cron" ? `cron "${task.schedule.expression}"` : `once at ${when(task.schedule.at)}`;
  const steer = task.delivery === "steer" ? " · steer" : "";
  const state = task.nextRunAt === null ? "finished" : task.enabled ? `next ${when(task.nextRunAt)}` : "paused";
  const last = task.lastRunAt
    ? ` · last ${when(task.lastRunAt)}${task.lastStatus === "error" ? ` FAILED: ${task.lastError ?? "unknown"}` : ""}`
    : "";
  return `[${task.id}] ${task.name} · ${schedule}${steer} · ${state}${last}\n  prompt: ${task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt}`;
}

const deliveryParameter = Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
  description: 'Only matters if this session is busy when the task fires. "followUp" (default) waits until the current work is finished. "steer" interrupts after the current tool calls; use it only when the message should change what you are doing right then. Recurring (cron) tasks are always "followUp".',
}));

const scheduleParameters = {
  delay_seconds: Type.Optional(Type.Number({ description: "One-shot: fire this many seconds from now (at least 60)." })),
  at: Type.Optional(Type.String({ description: "One-shot: fire at this ISO 8601 date-time, e.g. 2026-11-11T09:00:00+08:00." })),
  cron: Type.Optional(Type.String({ description: "Recurring: 5-field cron expression in the server's local time, e.g. \"0 9 * * 1-5\" or \"*/30 * * * *\"." })),
};

function scheduleInput(params: { delay_seconds?: number; at?: string; cron?: string }): ScheduleInput {
  return {
    ...(params.delay_seconds !== undefined ? { delaySeconds: params.delay_seconds } : {}),
    ...(params.at !== undefined ? { at: params.at } : {}),
    ...(params.cron !== undefined ? { cron: params.cron } : {}),
  };
}

function preview(task: ScheduledTask): string {
  if (task.schedule.kind !== "cron") return "";
  const fires = nextCronFires(task.schedule.expression, 3, new Date());
  return fires.length ? `\nNext fires: ${fires.map((date) => date.toLocaleString()).join(", ")}` : "";
}

function sessionLabel(sessionManager: { getSessionName(): string | undefined; getEntries(): unknown[] }): string | undefined {
  const name = sessionManager.getSessionName()?.trim();
  if (name) return name;
  for (const entry of sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const value = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block: { type?: string; text?: string }) => block.type === "text" ? block.text ?? "" : "").join(" ")
        : "";
    const line = value.trim().split("\n")[0];
    if (line) return line.slice(0, 80);
  }
  return undefined;
}

export function createScheduledTaskExtension(options: {
  cwd: string;
  isEnabled: () => boolean;
  /** Starts the process-wide scheduler (lib/scheduled-task-scheduler.ts) without a static import cycle. */
  ensureScheduler?: () => void;
}): InlineExtension {
  return {
    name: HOST_SCHEDULED_TASK_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Off in Settings › General: no tools and no prompt text. A reload applies a change.
      if (!options.isEnabled()) return;
      options.ensureScheduler?.();
      const disabled = () => options.isEnabled()
        ? undefined
        : text("Scheduled tasks are turned off in pi-web Settings › General.", true);

      pi.registerTool(defineTool({
        name: "schedule_create",
        label: "Schedule task",
        description: `Schedule a prompt to be sent back into THIS session later, once or on a recurring cron schedule. pi-web owns the schedule: when the task is due it reopens this session if needed (even after the page was closed or pi-web restarted) and delivers the prompt as a new turn, so you wake up and continue. If the session is busy at that moment the prompt waits until the current work is finished (delivery "followUp", the default), or, for a one-shot task with delivery "steer", interrupts after the current tool calls. Use it to check back on something later (a build, a deploy, a long job), for periodic checks, or for reminders.

Give exactly one of delay_seconds (one-shot, at least 60), at (one-shot, ISO 8601), or cron (recurring, 5 fields, server local time). A task missed while pi-web was stopped fires once when it starts again.`,
        promptSnippet: "Schedule a prompt that wakes this session later (once or recurring)",
        promptGuidelines: [
          "To wait for something slow, finish your turn and use schedule_create to wake yourself later instead of sleeping in bash or polling in a loop.",
          "Write the task prompt so it stands on its own: say what to check or do and what to report, because it arrives as a new turn.",
          "Delete recurring tasks with schedule_delete once they are no longer needed.",
        ],
        parameters: Type.Object({
          name: Type.String({ description: "Short label shown in the task list, e.g. \"check CI\"." }),
          prompt: Type.String({ description: "The message delivered to this session when the task fires." }),
          delivery: deliveryParameter,
          ...scheduleParameters,
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const blocked = disabled();
          if (blocked) return blocked;
          try {
            const task = await createScheduledTask({
              sessionId: ctx.sessionManager.getSessionId(),
              cwd: options.cwd,
              sessionLabel: sessionLabel(ctx.sessionManager),
              name: params.name,
              prompt: params.prompt,
              ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
              ...scheduleInput(params),
            });
            options.ensureScheduler?.();
            return text(`Scheduled.\n${describeTask(task)}${preview(task)}`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "schedule_list",
        label: "List scheduled tasks",
        description: "List this session's scheduled tasks with their next fire time and the result of the last fire.",
        promptSnippet: "List this session's scheduled tasks",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          const tasks = listScheduledTasks({ sessionId: ctx.sessionManager.getSessionId() });
          return text(tasks.length ? tasks.map(describeTask).join("\n") : "This session has no scheduled tasks.");
        },
      }));

      pi.registerTool(defineTool({
        name: "schedule_update",
        label: "Update scheduled task",
        description: "Change one of this session's scheduled tasks: its name, prompt, schedule (one of delay_seconds, at, cron), or pause/resume it with enabled. A resumed cron task continues from its next occurrence; a finished one-shot task needs a new delay_seconds or at.",
        promptSnippet: "Change, pause or resume a scheduled task",
        parameters: Type.Object({
          id: Type.String({ description: "Task id from schedule_create or schedule_list." }),
          name: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String()),
          enabled: Type.Optional(Type.Boolean({ description: "false pauses the task, true resumes it." })),
          delivery: deliveryParameter,
          ...scheduleParameters,
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const blocked = disabled();
          if (blocked) return blocked;
          try {
            const task = await updateScheduledTask(params.id, {
              ...(params.name !== undefined ? { name: params.name } : {}),
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
              ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
              ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
              ...scheduleInput(params),
            }, { sessionId: ctx.sessionManager.getSessionId() });
            return text(`Updated.\n${describeTask(task)}${preview(task)}`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "schedule_delete",
        label: "Delete scheduled task",
        description: "Delete one of this session's scheduled tasks.",
        promptSnippet: "Delete a scheduled task",
        parameters: Type.Object({
          id: Type.String({ description: "Task id from schedule_create or schedule_list." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const deleted = await deleteScheduledTask(params.id, { sessionId: ctx.sessionManager.getSessionId() });
          return deleted ? text(`Deleted task ${params.id}.`) : text(`No task ${params.id} in this session. Use schedule_list.`, true);
        },
      }));
    },
  };
}
