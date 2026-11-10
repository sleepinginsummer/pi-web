import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Settings › General's background command switch. On by default: the tool
 * only runs commands in sessions whose bash tool is active, so it adds no
 * capability beyond it. Off removes the tool when a session reloads; commands
 * already running keep running. A damaged file fails closed.
 */

type StoredBackgroundCommandSettings = Record<string, unknown> & { enabled?: unknown };

export function getBackgroundCommandSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-background-command-settings.json");
}

function readStored(settingsPath: string): StoredBackgroundCommandSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid background command settings: expected an object");
  }
  return parsed as StoredBackgroundCommandSettings;
}

export function isBackgroundCommandsEnabled(settingsPath = getBackgroundCommandSettingsPath()): boolean {
  try {
    return readStored(settingsPath).enabled !== false;
  } catch {
    return false;
  }
}

export function writeBackgroundCommandsEnabled(enabled: boolean, settingsPath = getBackgroundCommandSettingsPath()): boolean {
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, enabled }, null, 2));
  return isBackgroundCommandsEnabled(settingsPath);
}
