"use client";

import { useProjectDirectories } from "./useProjectDirectories";
import { useSidebarPreferences } from "./useSidebarPreferences";
import type { SessionInfo } from "@/lib/types";

/** 组合目录成员与侧边栏偏好，保证远端删除也能清理对应顺序和 Pin。 */
export function useSidebarNavigation(sessions: SessionInfo[], sessionsReady: boolean) {
  const preferences = useSidebarPreferences(sessions, sessionsReady);
  const directories = useProjectDirectories(preferences.removeProjects);
  return { ...preferences, ...directories };
}
