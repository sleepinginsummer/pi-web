import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Settings › General's scheduled task switch. On by default, like the dev
 * server switch. Off removes the tools (on the session's next reload) and
 * pauses the scheduler at once: stored tasks are kept and an overdue one fires
 * once when the switch is turned back on. A damaged file fails closed.
 */

type StoredScheduledTaskSettings = Record<string, unknown> & { enabled?: unknown };

export function getScheduledTaskSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-scheduled-task-settings.json");
}

function readStored(settingsPath: string): StoredScheduledTaskSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid scheduled task settings: expected an object");
  }
  return parsed as StoredScheduledTaskSettings;
}

export function isScheduledTasksEnabled(settingsPath = getScheduledTaskSettingsPath()): boolean {
  try {
    return readStored(settingsPath).enabled !== false;
  } catch {
    return false;
  }
}

export function writeScheduledTasksEnabled(enabled: boolean, settingsPath = getScheduledTaskSettingsPath()): boolean {
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, enabled }, null, 2));
  return isScheduledTasksEnabled(settingsPath);
}
