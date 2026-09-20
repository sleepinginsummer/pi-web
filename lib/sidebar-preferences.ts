import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import {
  emptySidebarPreferences,
  parseSidebarPreferences,
  reduceSidebarPreferences,
  type SidebarPreferenceAction,
  type SidebarPreferences,
} from "./sidebar-preference-state";

const FILE_NAME = "pi-web-sidebar-preferences.json";

export type { SidebarPreferenceAction, SidebarPreferences } from "./sidebar-preference-state";

export class SidebarPreferencesConflictError extends Error {
  constructor(readonly current: SidebarPreferences) {
    super("sidebar preferences changed");
    this.name = "SidebarPreferencesConflictError";
  }
}

export function getSidebarPreferencesPath(): string {
  return join(getAgentDir(), FILE_NAME);
}

export function readSidebarPreferences(filePath = getSidebarPreferencesPath()): SidebarPreferences {
  if (!existsSync(filePath)) return emptySidebarPreferences();
  try {
    return parseSidebarPreferences(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    console.error("[pi-web] 读取侧边栏偏好失败:", error);
    return emptySidebarPreferences();
  }
}
async function mutateSidebarPreferences(
  filePath: string,
  mutation: (current: SidebarPreferences) => SidebarPreferences,
): Promise<SidebarPreferences> {
  return withPrivateFileLock(filePath, () => {
    const current = readSidebarPreferences(filePath);
    const next = mutation(current);
    if (next !== current) writePrivateFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function updateSidebarPreferences(
  expectedRevision: number,
  action: SidebarPreferenceAction,
  filePath = getSidebarPreferencesPath(),
): Promise<SidebarPreferences> {
  return mutateSidebarPreferences(filePath, (current) => {
    if (current.revision !== expectedRevision) throw new SidebarPreferencesConflictError(current);
    return reduceSidebarPreferences(current, action, true);
  });
}

export function removeSidebarPreferenceIds(
  removals: { projectPaths?: string[]; sessionIds?: string[] },
  filePath = getSidebarPreferencesPath(),
): Promise<SidebarPreferences> {
  return mutateSidebarPreferences(filePath, (current) => {
    let next = current;
    if (removals.projectPaths?.length) {
      next = reduceSidebarPreferences(next, { type: "remove_projects", ids: removals.projectPaths }, false);
    }
    if (removals.sessionIds?.length) {
      next = reduceSidebarPreferences(next, { type: "remove_sessions", ids: removals.sessionIds }, false);
    }
    return next === current ? current : { ...next, revision: current.revision + 1 };
  });
}
