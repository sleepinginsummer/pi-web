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


export interface SidebarProjectGroup {
  path: string;
  worktrees: string[];
}

/** 仅组织显示层级；checkout 身份仍用于排序、移除和会话筛选。 */
export function groupSidebarProjects(
  projects: readonly string[],
  sessions: readonly SessionInfo[],
  checkout?: { projectRoot: string; worktrees: readonly { path: string; isMain: boolean }[] } | null,
  orderProjects?: (paths: string[]) => string[],
): SidebarProjectGroup[] {
  const parents = new Map<string, string>();
  for (const session of sessions) {
    if (session.isWorktree && session.projectRoot && !samePortablePath(session.cwd, session.projectRoot)) {
      parents.set(portablePathIdentity(session.cwd), session.projectRoot);
    }
  }
  // 当前 checkout 的元数据也覆盖尚未发送过消息的 worktree。
  if (checkout) {
    for (const worktree of checkout.worktrees) {
      if (!worktree.isMain && !samePortablePath(worktree.path, checkout.projectRoot)) {
        parents.set(portablePathIdentity(worktree.path), checkout.projectRoot);
      }
    }
  }
  const groups = new Map<string, SidebarProjectGroup>();
  for (const project of projects) {
    const parent = parents.get(portablePathIdentity(project));
    const path = parent ?? project;
    const identity = portablePathIdentity(path);
    let group = groups.get(identity);
    if (!group) {
      group = { path, worktrees: [] };
      groups.set(identity, group);
    }
    if (parent && !group.worktrees.some((item) => samePortablePath(item, project))) group.worktrees.push(project);
  }
  if (!orderProjects) return [...groups.values()];
  // 一级组只读取父目录的顺序，子目录的旧位置不能再抢占父组的位置。
  return orderProjects([...groups.values()].map((group) => group.path))
    .map((path) => groups.get(portablePathIdentity(path))!);
}


function findSidebarProjectGroup(groups: readonly SidebarProjectGroup[], path: string) {
  return groups.find((group) => samePortablePath(group.path, path)
    || group.worktrees.some((worktree) => samePortablePath(worktree, path)));
}

/** 父组独立排序；worktree 只在同一父组内排序，避免跨层拖拽改乱目录顺序。 */
export function resolveSidebarProjectMove(
  groups: readonly SidebarProjectGroup[], source: string, target: string,
): { source: string; target: string; visibleIds: string[] } | null {
  const sourceGroup = findSidebarProjectGroup(groups, source);
  const targetGroup = findSidebarProjectGroup(groups, target);
  if (!sourceGroup || !targetGroup) return null;
  if (samePortablePath(sourceGroup.path, source)) {
    if (sourceGroup === targetGroup) return null;
    return { source: sourceGroup.path, target: targetGroup.path, visibleIds: groups.map((group) => group.path) };
  }
  if (sourceGroup !== targetGroup) return null;
  const sourcePath = sourceGroup.worktrees.find((path) => samePortablePath(path, source));
  const targetPath = sourceGroup.worktrees.find((path) => samePortablePath(path, target));
  if (!sourcePath || !targetPath || samePortablePath(sourcePath, targetPath)) return null;
  return { source: sourcePath, target: targetPath, visibleIds: sourceGroup.worktrees };
}

/** 按路径身份查找实际显示的父组与 checkout，展开两层并保留无关折叠状态。 */
export function expandSidebarProject(
  groups: readonly SidebarProjectGroup[], collapsed: Set<string>, projectPath: string,
): Set<string> {
  const group = findSidebarProjectGroup(groups, projectPath);
  if (!group) return collapsed;
  const paths = [group.path, ...group.worktrees.filter((path) => samePortablePath(path, projectPath))];
  const next = new Set([...collapsed].filter((key) => !paths.some((path) => samePortablePath(key, path))));
  return next.size === collapsed.size ? collapsed : next;
}
