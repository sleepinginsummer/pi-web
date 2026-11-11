import { statSync } from "node:fs";
import { isBackgroundCommandActive, listBackgroundCommands } from "./background-commands";
import { getScheduledTasksPath, listScheduledTasks } from "./scheduled-tasks";
import { isScheduledTasksEnabled } from "./scheduled-task-settings";

/**
 * Per-session work that runs or waits outside the agent's own turn, for the
 * sidebar: running background commands, and the next time a scheduled task
 * will wake the session. Kept apart from `runningSessionIds` on purpose — that
 * set drives completion notifications and unread markers, and a command
 * finishing is not the agent finishing (the command's exit wakes the session,
 * which then runs and notifies through the normal path).
 *
 * Dev servers are keyed by project cwd, not by session, so they are not here.
 */
export interface SessionBackgroundActivity {
  sessionId: string;
  /** Background commands still running or stopping. */
  commands: number;
  /** Earliest pending fire time of an enabled scheduled task, or null. */
  nextTaskAt: number | null;
}

interface TaskCache {
  key: string;
  next: Map<string, number>;
}

let taskCache: TaskCache | null = null;

/** Next fire time per session; re-reads the task file only when it changed. */
function nextTaskTimes(): Map<string, number> {
  if (!isScheduledTasksEnabled()) return new Map();
  const path = getScheduledTasksPath();
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return new Map();
  }
  if (taskCache?.key === key) return taskCache.next;
  const next = new Map<string, number>();
  for (const task of listScheduledTasks({}, path)) {
    if (!task.enabled || task.nextRunAt === null) continue;
    const current = next.get(task.sessionId);
    if (current === undefined || task.nextRunAt < current) next.set(task.sessionId, task.nextRunAt);
  }
  taskCache = { key, next };
  return next;
}

export function listSessionBackgroundActivity(): SessionBackgroundActivity[] {
  const commands = new Map<string, number>();
  for (const command of listBackgroundCommands()) {
    if (!isBackgroundCommandActive(command.status)) continue;
    commands.set(command.sessionId, (commands.get(command.sessionId) ?? 0) + 1);
  }
  let tasks: Map<string, number>;
  try {
    tasks = nextTaskTimes();
  } catch {
    tasks = new Map();
  }
  const ids = new Set([...commands.keys(), ...tasks.keys()]);
  return [...ids].map((sessionId) => ({
    sessionId,
    commands: commands.get(sessionId) ?? 0,
    nextTaskAt: tasks.get(sessionId) ?? null,
  }));
}
