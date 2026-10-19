import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Settings › General's dev server switch. On by default: the tools only start
 * processes in sessions whose bash tool is active, so they add no capability
 * beyond it. A damaged file fails closed, like the built-in subagent switch.
 */

type StoredDevServerSettings = Record<string, unknown> & { enabled?: unknown };

export function getDevServerSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-dev-servers.json");
}

function readStored(settingsPath: string): StoredDevServerSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid dev server settings: expected an object");
  }
  return parsed as StoredDevServerSettings;
}

export function isDevServersEnabled(settingsPath = getDevServerSettingsPath()): boolean {
  try {
    return readStored(settingsPath).enabled !== false;
  } catch {
    return false;
  }
}

export function writeDevServersEnabled(enabled: boolean, settingsPath = getDevServerSettingsPath()): boolean {
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, enabled }, null, 2));
  return isDevServersEnabled(settingsPath);
}
