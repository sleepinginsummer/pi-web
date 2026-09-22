import { portablePathIdentity, samePortablePath } from "./path-equality";
import type { SessionInfo } from "./types";

export interface ProjectActivity {
  running: number;
  unread: number;
}

export interface ProjectActivityIndex {
  get(projectPath: string): ProjectActivity | undefined;
  hasActivityOutside(projectPath: string | null): boolean;
}

/** 会话在侧边栏项目列表中的唯一归属路径。 */
export function sidebarProjectPath(session: Pick<SessionInfo, "cwd" | "isWorktree" | "projectRoot">): string {
  return session.isWorktree ? session.cwd : (session.projectRoot ?? session.cwd);
}

/** 将当前 cwd 与 checkout 元数据解析为同一侧边栏项目身份。 */
export function resolveSidebarProjectPath(
  sessions: readonly SessionInfo[],
  cwd: string | null,
  options: {
    projectRoot?: string | null;
    worktrees?: readonly { path: string; isMain: boolean }[];
  } = {},
): string | null {
  if (!cwd) return null;
  const session = sessions.find((item) => samePortablePath(item.cwd, cwd));
  if (session) return sidebarProjectPath(session);
  const worktree = options.worktrees?.find((item) => samePortablePath(item.path, cwd));
  if (worktree && !worktree.isMain) return worktree.path;
  return options.projectRoot ?? cwd;
}

/** 按最近活动排序侧边栏项目，并保持主仓库与 worktree 独立。 */
export function getRecentProjects(sessions: readonly SessionInfo[]): string[] {
  const latestByProject = new Map<string, { path: string; modified: string }>();
  for (const session of sessions) {
    const project = sidebarProjectPath(session);
    if (!project) continue;
    const identity = portablePathIdentity(project);
    const previous = latestByProject.get(identity);
    if (!previous) latestByProject.set(identity, { path: project, modified: session.modified });
    else if (session.modified > previous.modified) previous.modified = session.modified;
  }
  return [...latestByProject.values()]
    .sort((left, right) => right.modified.localeCompare(left.modified))
    .map(({ path }) => path);
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): ProjectActivityIndex {
  const counts = new Map<string, ProjectActivity>();
  for (const session of sessions) {
    const identity = portablePathIdentity(sidebarProjectPath(session));
    const entry = counts.get(identity) ?? { running: 0, unread: 0 };
    if (runningSessionIds.has(session.id)) entry.running += 1;
    if (unreadSessionIds.has(session.id)) entry.unread += 1;
    counts.set(identity, entry);
  }
  return {
    get: (projectPath) => counts.get(portablePathIdentity(projectPath)),
    hasActivityOutside: (projectPath) => {
      const selectedIdentity = projectPath ? portablePathIdentity(projectPath) : null;
      return [...counts.entries()].some(([identity, value]) => identity !== selectedIdentity && (value.running > 0 || value.unread > 0));
    },
  };
}

/** 按侧边栏项目身份筛选会话，供展示、计数和删除复用。 */
export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectPath: string,
): SessionInfo[] {
  return sessions.filter((session) => samePortablePath(sidebarProjectPath(session), projectPath));
}
