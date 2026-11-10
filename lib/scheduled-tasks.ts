import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import { nextCronFire, validateCron } from "./cron-schedule";
import type { ScheduledTask, ScheduledTaskSchedule } from "./types";

/**
 * Scheduled task store: `<agentDir>/pi-web-scheduled-tasks.json`. Every
 * mutation is a locked read-modify-write, so the scheduler, the agent's tools
 * and the browser can change tasks at the same time. A damaged file is kept
 * aside and the store starts empty instead of wedging the scheduler.
 */

export const MAX_TASKS_PER_SESSION = 20;
export const MAX_TASKS_TOTAL = 200;
export const MIN_ONCE_DELAY_MS = 60_000;
export const MAX_PROMPT_LENGTH = 8_000;
export const MAX_NAME_LENGTH = 80;
/** One-shot tasks that fired are kept this long so the list can show how they went. */
export const FINISHED_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

interface StoreFile {
  version: 1;
  tasks: ScheduledTask[];
}

export function getScheduledTasksPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-scheduled-tasks.json");
}

function isTask(value: unknown): value is ScheduledTask {
  const task = value as ScheduledTask;
  if (!task || typeof task !== "object") return false;
  if (typeof task.id !== "string" || typeof task.sessionId !== "string" || typeof task.cwd !== "string") return false;
  if (typeof task.name !== "string" || typeof task.prompt !== "string" || typeof task.enabled !== "boolean") return false;
  if (task.nextRunAt !== null && typeof task.nextRunAt !== "number") return false;
  const schedule = task.schedule as ScheduledTaskSchedule | undefined;
  if (schedule?.kind === "once") return typeof schedule.at === "number";
  if (schedule?.kind === "cron") return typeof schedule.expression === "string" && validateCron(schedule.expression) === null;
  return false;
}

function readTasks(path: string): ScheduledTask[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
    if (!Array.isArray(parsed?.tasks)) throw new Error("tasks is not an array");
    return parsed.tasks.filter(isTask).map((task) => ({ ...task, runCount: Number(task.runCount) || 0 }));
  } catch (error) {
    console.warn("[pi-web] scheduled task store is unreadable, starting empty:", error instanceof Error ? error.message : error);
    try {
      writePrivateFileAtomicSync(`${path}.corrupt-${Date.now()}`, readFileSync(path, "utf8"));
      writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, tasks: [] }, null, 2));
    } catch {
      // The next read reports it again.
    }
    return [];
  }
}

function writeTasks(path: string, tasks: ScheduledTask[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, tasks } satisfies StoreFile, null, 2));
}

/** Drop one-shot tasks that finished more than a day ago. */
function prune(tasks: ScheduledTask[], now: number): ScheduledTask[] {
  return tasks.filter((task) => !(task.schedule.kind === "once"
    && task.nextRunAt === null
    && (task.lastRunAt ?? task.updatedAt) + FINISHED_TASK_RETENTION_MS < now));
}

async function mutate<T>(operation: (tasks: ScheduledTask[]) => { tasks: ScheduledTask[]; result: T }, path = getScheduledTasksPath()): Promise<T> {
  return withPrivateFileLock(path, () => {
    const { tasks, result } = operation(readTasks(path));
    writeTasks(path, prune(tasks, Date.now()));
    return result;
  });
}

export function listScheduledTasks(filter: { cwd?: string; sessionId?: string } = {}, path = getScheduledTasksPath()): ScheduledTask[] {
  return readTasks(path)
    .filter((task) => (filter.cwd === undefined || task.cwd === filter.cwd)
      && (filter.sessionId === undefined || task.sessionId === filter.sessionId))
    .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
}

export function getScheduledTask(id: string, path = getScheduledTasksPath()): ScheduledTask | undefined {
  return readTasks(path).find((task) => task.id === id);
}

export type TaskDelivery = "followUp" | "steer";

export function taskDelivery(task: Pick<ScheduledTask, "delivery" | "schedule">): TaskDelivery {
  return task.schedule.kind === "once" && task.delivery === "steer" ? "steer" : "followUp";
}

/** Recurring tasks would interrupt long work again and again, so only one-shot tasks may steer. */
function checkDelivery(delivery: unknown, schedule: ScheduledTaskSchedule): TaskDelivery | undefined {
  if (delivery === undefined) return undefined;
  if (delivery !== "followUp" && delivery !== "steer") throw new Error('delivery must be "followUp" or "steer".');
  if (delivery === "steer" && schedule.kind === "cron") {
    throw new Error('Recurring (cron) tasks always use delivery "followUp" so they never interrupt work in progress. Use a one-shot task to steer.');
  }
  return delivery;
}

export interface ScheduleInput {
  /** Seconds from now, for a one-shot task. */
  delaySeconds?: number;
  /** ISO 8601 date-time, for a one-shot task. */
  at?: string;
  /** 5-field cron expression, for a recurring task. */
  cron?: string;
}

/** Turn the tool's schedule arguments into a schedule and its first fire time. */
export function resolveSchedule(input: ScheduleInput, now: number): { schedule: ScheduledTaskSchedule; nextRunAt: number } {
  const given = [input.delaySeconds !== undefined, input.at !== undefined, input.cron !== undefined].filter(Boolean).length;
  if (given !== 1) throw new Error("Give exactly one of delay_seconds, at, or cron.");
  if (input.cron !== undefined) {
    const expression = input.cron.trim();
    const error = validateCron(expression);
    if (error) throw new Error(`Invalid cron expression "${expression}": ${error}`);
    const next = nextCronFire(expression, new Date(now));
    if (!next) throw new Error(`Cron expression "${expression}" never fires.`);
    return { schedule: { kind: "cron", expression }, nextRunAt: next.getTime() };
  }
  let at: number;
  if (input.delaySeconds !== undefined) {
    if (!Number.isFinite(input.delaySeconds)) throw new Error("delay_seconds must be a number.");
    at = now + Math.round(input.delaySeconds * 1000);
  } else {
    at = Date.parse(input.at!);
    if (Number.isNaN(at)) throw new Error(`"${input.at}" is not an ISO 8601 date-time.`);
  }
  if (at < now + MIN_ONCE_DELAY_MS) {
    throw new Error(`A one-shot task must be at least ${MIN_ONCE_DELAY_MS / 1000} seconds in the future.`);
  }
  return { schedule: { kind: "once", at }, nextRunAt: at };
}

function checkText(name: string, prompt: string): void {
  if (!name) throw new Error("name is required.");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`name is longer than ${MAX_NAME_LENGTH} characters.`);
  if (!prompt) throw new Error("prompt is required: it is what the session receives when the task fires.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt is longer than ${MAX_PROMPT_LENGTH} characters.`);
}

export async function createScheduledTask(input: {
  sessionId: string;
  cwd: string;
  sessionLabel?: string;
  name: string;
  prompt: string;
  delivery?: TaskDelivery;
} & ScheduleInput, now = Date.now(), path = getScheduledTasksPath()): Promise<ScheduledTask> {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  checkText(name, prompt);
  const { schedule, nextRunAt } = resolveSchedule(input, now);
  const delivery = checkDelivery(input.delivery, schedule);
  return mutate((tasks) => {
    if (tasks.filter((task) => task.sessionId === input.sessionId && task.nextRunAt !== null).length >= MAX_TASKS_PER_SESSION) {
      throw new Error(`This session already has ${MAX_TASKS_PER_SESSION} pending tasks. Delete one first.`);
    }
    if (tasks.length >= MAX_TASKS_TOTAL) throw new Error(`There are already ${MAX_TASKS_TOTAL} scheduled tasks. Delete some first.`);
    const task: ScheduledTask = {
      id: randomBytes(4).toString("hex"),
      sessionId: input.sessionId,
      cwd: input.cwd,
      ...(input.sessionLabel ? { sessionLabel: input.sessionLabel.slice(0, 120) } : {}),
      name,
      prompt,
      schedule,
      ...(delivery === "steer" ? { delivery } : {}),
      enabled: true,
      nextRunAt,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return { tasks: [...tasks, task], result: task };
  }, path);
}

export async function updateScheduledTask(
  id: string,
  changes: { name?: string; prompt?: string; enabled?: boolean; delivery?: TaskDelivery } & ScheduleInput,
  options: { sessionId?: string; now?: number } = {},
  path = getScheduledTasksPath(),
): Promise<ScheduledTask> {
  const now = options.now ?? Date.now();
  const hasSchedule = changes.delaySeconds !== undefined || changes.at !== undefined || changes.cron !== undefined;
  const resolved = hasSchedule ? resolveSchedule(changes, now) : undefined;
  return mutate((tasks) => {
    const index = tasks.findIndex((task) => task.id === id && (options.sessionId === undefined || task.sessionId === options.sessionId));
    if (index < 0) throw new Error(`No scheduled task ${id}${options.sessionId ? " in this session" : ""}.`);
    const task = { ...tasks[index] };
    if (changes.name !== undefined) task.name = changes.name.trim();
    if (changes.prompt !== undefined) task.prompt = changes.prompt.trim();
    checkText(task.name, task.prompt);
    if (resolved) {
      task.schedule = resolved.schedule;
      task.nextRunAt = resolved.nextRunAt;
      if (changes.enabled === undefined) task.enabled = true;
    }
    if (changes.enabled !== undefined && changes.enabled !== task.enabled) {
      task.enabled = changes.enabled;
      if (changes.enabled && !resolved && task.schedule.kind === "cron") {
        // Resume at the next occurrence from now, not with a catch-up fire.
        task.nextRunAt = nextCronFire(task.schedule.expression, new Date(now))?.getTime() ?? null;
      }
    }
    // A task moved to a cron schedule drops a stored steer unless the caller asks for it again.
    const delivery = checkDelivery(changes.delivery ?? (task.schedule.kind === "cron" ? undefined : task.delivery), task.schedule);
    if (delivery === "steer") task.delivery = "steer";
    else delete task.delivery;
    if (task.enabled && task.nextRunAt === null) {
      throw new Error("This one-shot task already fired. Give it a new delay_seconds or at to schedule it again.");
    }
    task.updatedAt = now;
    const next = [...tasks];
    next[index] = task;
    return { tasks: next, result: task };
  }, path);
}

export async function deleteScheduledTask(id: string, options: { sessionId?: string } = {}, path = getScheduledTasksPath()): Promise<boolean> {
  return mutate((tasks) => {
    const next = tasks.filter((task) => !(task.id === id && (options.sessionId === undefined || task.sessionId === options.sessionId)));
    return { tasks: next, result: next.length !== tasks.length };
  }, path);
}

export async function deleteScheduledTasksForSession(sessionId: string, path = getScheduledTasksPath()): Promise<number> {
  if (!readTasks(path).some((task) => task.sessionId === sessionId)) return 0;
  return mutate((tasks) => {
    const next = tasks.filter((task) => task.sessionId !== sessionId);
    return { tasks: next, result: tasks.length - next.length };
  }, path);
}

/** Advance a task past a fire at `now`: a cron task moves to its next occurrence, a one-shot one finishes. */
function advance(task: ScheduledTask, now: number): ScheduledTask {
  const next = task.schedule.kind === "cron" ? nextCronFire(task.schedule.expression, new Date(now))?.getTime() ?? null : null;
  return {
    ...task,
    lastRunAt: now,
    runCount: task.runCount + 1,
    nextRunAt: next,
    enabled: next !== null && task.enabled,
    updatedAt: now,
  };
}

/**
 * Claim every enabled task that is due: record the fire and move the task to
 * its next occurrence before it is delivered, so a crash during delivery never
 * fires it again in a loop. Missed occurrences collapse into this one fire.
 */
export async function claimDueTasks(now = Date.now(), path = getScheduledTasksPath()): Promise<ScheduledTask[]> {
  if (!readTasks(path).some((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)) return [];
  return mutate((tasks) => {
    const claimed: ScheduledTask[] = [];
    const next = tasks.map((task) => {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) return task;
      claimed.push(task);
      return advance(task, now);
    });
    return { tasks: next, result: claimed };
  }, path);
}

/** Claim one task for an immediate run (the list's Run now button) without moving a cron schedule. */
export async function claimTaskNow(id: string, now = Date.now(), path = getScheduledTasksPath()): Promise<ScheduledTask> {
  return mutate((tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error(`No scheduled task ${id}.`);
    const task = tasks[index];
    const next = [...tasks];
    next[index] = task.schedule.kind === "once"
      ? advance(task, now)
      : { ...task, lastRunAt: now, runCount: task.runCount + 1, updatedAt: now };
    return { tasks: next, result: task };
  }, path);
}

export async function recordTaskResult(
  id: string,
  result: { ok: true } | { ok: false; error: string; disable?: boolean },
  path = getScheduledTasksPath(),
): Promise<void> {
  await mutate((tasks) => ({
    tasks: tasks.map((task) => {
      if (task.id !== id) return task;
      const next: ScheduledTask = { ...task, lastStatus: result.ok ? "ok" : "error", updatedAt: Date.now() };
      if (result.ok) delete next.lastError;
      else {
        next.lastError = result.error.slice(0, 300);
        if (result.disable) next.enabled = false;
      }
      return next;
    }),
    result: undefined,
  }), path);
}
