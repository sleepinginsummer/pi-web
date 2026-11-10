import { isScheduledTasksEnabled } from "./scheduled-task-settings";
import { claimDueTasks, claimTaskNow, recordTaskResult, taskDelivery } from "./scheduled-tasks";
import { SessionWakeError, wakeSession } from "./session-wake";
import { SCHEDULED_TASK_MESSAGE_TYPE } from "./wake-message-types";
import type { ScheduledTask } from "./types";

/**
 * The server-side scheduler. It lives in the pi-web process, not in a session:
 * a due task wakes its session through lib/session-wake.ts, which reopens it
 * if the wrapper was reaped. Delivery is the task's choice: follow-up by
 * default, steer only for one-shot tasks.
 *
 * `globalThis` keeps one interval across hot reloads; every module load
 * replaces `tick`, so the interval always runs the current code.
 */

export const SCHEDULER_TICK_MS = 15_000;
/** First tick after start, so overdue tasks catch up soon after pi-web boots. */
const FIRST_TICK_DELAY_MS = 5_000;

export { SCHEDULED_TASK_MESSAGE_TYPE };

interface SchedulerState {
  interval: ReturnType<typeof setInterval> | null;
  tick: (() => Promise<void>) | null;
  ticking: boolean;
}

declare global {
  var __piWebScheduledTaskScheduler: SchedulerState | undefined;
}

function state(): SchedulerState {
  globalThis.__piWebScheduledTaskScheduler ??= { interval: null, tick: null, ticking: false };
  return globalThis.__piWebScheduledTaskScheduler;
}

export function describeSchedule(task: Pick<ScheduledTask, "schedule">): string {
  return task.schedule.kind === "cron"
    ? `cron "${task.schedule.expression}"`
    : `once at ${new Date(task.schedule.at).toLocaleString()}`;
}

export function scheduledTaskMessage(task: ScheduledTask, manual: boolean): string {
  const how = manual ? "was run manually by the user" : "fired";
  const next = task.schedule.kind === "cron"
    ? " It will fire again on schedule; use schedule_update or schedule_delete if it is no longer needed."
    : "";
  return `⏰ Scheduled task "${task.name}" [${task.id}] ${how} (${describeSchedule(task)}).${next}\n\n${task.prompt}`;
}

/** Wake the task's session with its prompt. Resolves once the turn started or was queued. */
export async function deliverScheduledTask(task: ScheduledTask, options: { manual?: boolean } = {}): Promise<void> {
  try {
    await wakeSession({
      sessionId: task.sessionId,
      cwd: task.cwd,
      customType: SCHEDULED_TASK_MESSAGE_TYPE,
      content: scheduledTaskMessage(task, Boolean(options.manual)),
      details: { taskId: task.id, name: task.name, schedule: task.schedule, delivery: taskDelivery(task), manual: Boolean(options.manual) },
      delivery: taskDelivery(task),
      onLateError: (error) => {
        void recordTaskResult(task.id, { ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      },
    });
    await recordTaskResult(task.id, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[pi-web] scheduled task delivery failed", { taskId: task.id, sessionId: task.sessionId, error: message });
    await recordTaskResult(task.id, {
      ok: false,
      error: message,
      disable: error instanceof SessionWakeError && error.permanent,
    }).catch(() => undefined);
    throw error;
  }
}

/** Deliver due tasks: one session's tasks in order, different sessions side by side. */
async function deliverAll(tasks: ScheduledTask[]): Promise<void> {
  const bySession = new Map<string, ScheduledTask[]>();
  for (const task of tasks) bySession.set(task.sessionId, [...(bySession.get(task.sessionId) ?? []), task]);
  await Promise.all([...bySession.values()].map(async (queue) => {
    for (const task of queue) await deliverScheduledTask(task).catch(() => undefined);
  }));
}

async function tick(): Promise<void> {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    if (!isScheduledTasksEnabled()) return;
    const due = await claimDueTasks();
    if (due.length > 0) await deliverAll(due);
  } catch (error) {
    console.warn("[pi-web] scheduled task tick failed:", error instanceof Error ? error.message : error);
  } finally {
    current.ticking = false;
  }
}

/** Start the scheduler once per process; later calls only install the current tick. */
export function ensureScheduledTaskScheduler(): void {
  const current = state();
  current.tick = tick;
  if (current.interval) return;
  current.interval = setInterval(() => { void state().tick?.(); }, SCHEDULER_TICK_MS);
  current.interval.unref?.();
  setTimeout(() => { void state().tick?.(); }, FIRST_TICK_DELAY_MS).unref?.();
}

/** The list's Run now button: fire a task immediately, keeping a cron task's schedule. */
export async function runScheduledTaskNow(id: string): Promise<void> {
  const task = await claimTaskNow(id);
  await deliverScheduledTask(task, { manual: true });
}
