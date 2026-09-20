export interface SidebarPreferences {
  version: 1;
  revision: number;
  legacyMigrationCompleted: boolean;
  projectOrder: string[];
  pinnedProjectPaths: string[];
  sessionOrder: string[];
  pinnedSessionIds: string[];
}

export type SidebarPreferenceAction =
  | { type: "move_project"; source: string; target: string; visibleIds: string[] }
  | { type: "set_project_pinned"; project: string; pinned: boolean }
  | { type: "move_session"; source: string; target: string; visibleIds: string[] }
  | { type: "set_session_pinned"; sessionId: string; pinned: boolean }
  | { type: "remove_projects"; ids: string[] }
  | { type: "remove_sessions"; ids: string[] }
  | { type: "merge_legacy"; sessionOrder: string[]; pinnedSessionIds: string[] };

export function uniquePreferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

export function emptySidebarPreferences(): SidebarPreferences {
  return {
    version: 1,
    revision: 0,
    legacyMigrationCompleted: false,
    projectOrder: [],
    pinnedProjectPaths: [],
    sessionOrder: [],
    pinnedSessionIds: [],
  };
}

export function parseSidebarPreferences(value: unknown): SidebarPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptySidebarPreferences();
  const raw = value as Partial<SidebarPreferences>;
  return {
    version: 1,
    revision: Number.isSafeInteger(raw.revision) && (raw.revision ?? -1) >= 0 ? raw.revision! : 0,
    legacyMigrationCompleted: raw.legacyMigrationCompleted === true,
    projectOrder: uniquePreferenceIds(raw.projectOrder),
    pinnedProjectPaths: uniquePreferenceIds(raw.pinnedProjectPaths),
    sessionOrder: uniquePreferenceIds(raw.sessionOrder),
    pinnedSessionIds: uniquePreferenceIds(raw.pinnedSessionIds),
  };
}

function moveVisibleItem(storedOrder: string[], visibleIds: string[], source: string, target: string): string[] {
  const visible = uniquePreferenceIds(visibleIds);
  if (!visible.includes(source) || !visible.includes(target) || source === target) return storedOrder;
  const visibleSet = new Set(visible);
  const hidden = storedOrder.filter((id) => !visibleSet.has(id));
  const nextVisible = [...visible];
  const sourceIndex = nextVisible.indexOf(source);
  const targetIndex = nextVisible.indexOf(target);
  nextVisible.splice(sourceIndex, 1);
  nextVisible.splice(targetIndex, 0, source);
  return [...nextVisible, ...hidden];
}

function setPinned(ids: string[], id: string, pinned: boolean): string[] {
  const next = ids.filter((item) => item !== id);
  if (pinned && id) next.push(id);
  return next;
}

function mergeOrder(current: string[], legacy: string[]): string[] {
  const next = [...current];
  const seen = new Set(next);
  for (const id of uniquePreferenceIds(legacy)) {
    if (!seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  return next;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function removeIds(ids: string[], removedIds: string[]): string[] {
  const removed = new Set(uniquePreferenceIds(removedIds));
  return ids.filter((id) => !removed.has(id));
}

/** 服务端与客户端乐观更新共用同一动作语义。 */
export function reduceSidebarPreferences(
  current: SidebarPreferences,
  action: SidebarPreferenceAction,
  incrementRevision: boolean,
): SidebarPreferences {
  if (action.type === "merge_legacy" && current.legacyMigrationCompleted) return current;
  if (action.type === "remove_projects") {
    const projectOrder = removeIds(current.projectOrder, action.ids);
    const pinnedProjectPaths = removeIds(current.pinnedProjectPaths, action.ids);
    if (sameIds(projectOrder, current.projectOrder) && sameIds(pinnedProjectPaths, current.pinnedProjectPaths)) return current;
    return { ...current, revision: current.revision + (incrementRevision ? 1 : 0), projectOrder, pinnedProjectPaths };
  }
  if (action.type === "remove_sessions") {
    const sessionOrder = removeIds(current.sessionOrder, action.ids);
    const pinnedSessionIds = removeIds(current.pinnedSessionIds, action.ids);
    if (sameIds(sessionOrder, current.sessionOrder) && sameIds(pinnedSessionIds, current.pinnedSessionIds)) return current;
    return { ...current, revision: current.revision + (incrementRevision ? 1 : 0), sessionOrder, pinnedSessionIds };
  }
  const next = { ...current, revision: current.revision + (incrementRevision ? 1 : 0) };
  switch (action.type) {
    case "move_project":
      next.projectOrder = moveVisibleItem(current.projectOrder, action.visibleIds, action.source, action.target);
      break;
    case "set_project_pinned":
      next.pinnedProjectPaths = setPinned(current.pinnedProjectPaths, action.project, action.pinned);
      break;
    case "move_session":
      next.sessionOrder = moveVisibleItem(current.sessionOrder, action.visibleIds, action.source, action.target);
      break;
    case "set_session_pinned":
      next.pinnedSessionIds = setPinned(current.pinnedSessionIds, action.sessionId, action.pinned);
      break;
    case "merge_legacy":
      next.sessionOrder = mergeOrder(current.sessionOrder, action.sessionOrder);
      next.pinnedSessionIds = mergeOrder(current.pinnedSessionIds, action.pinnedSessionIds);
      next.legacyMigrationCompleted = true;
      break;
  }
  return next;
}

function orderVisibleIdsByStored(visibleIds: string[], storedOrder: string[]): string[] {
  const visible = uniquePreferenceIds(visibleIds);
  const visibleSet = new Set(visible);
  const retained = storedOrder.filter((id) => visibleSet.has(id));
  const retainedSet = new Set(retained);
  return [...retained, ...visible.filter((id) => !retainedSet.has(id))];
}

/** 冲突后只重建顺序动作的可见基线；Pin 的显式目标值可以直接重放。 */
export function rebaseSidebarPreferenceAction(
  current: SidebarPreferences,
  action: SidebarPreferenceAction,
): SidebarPreferenceAction {
  if (action.type === "move_project") {
    return { ...action, visibleIds: orderVisibleIdsByStored(action.visibleIds, current.projectOrder) };
  }
  if (action.type === "move_session") {
    return { ...action, visibleIds: orderVisibleIdsByStored(action.visibleIds, current.sessionOrder) };
  }
  return action;
}

export function reconcileSessionPreferenceOrder(
  sessions: readonly { id: string; created: string }[],
  storedOrder: string[],
): string[] {
  const existingIds = new Set(sessions.map((session) => session.id));
  const retained = storedOrder.filter((id) => existingIds.has(id));
  const retainedIds = new Set(retained);
  const added = sessions
    .filter((session) => !retainedIds.has(session.id))
    .sort((left, right) => right.created.localeCompare(left.created))
    .map((session) => session.id);
  return [...added, ...retained];
}

export function orderProjectsByPreference(projects: string[], storedOrder: string[]): string[] {
  const unique = [...new Set(projects)];
  const visible = new Set(unique);
  const retained = storedOrder.filter((project) => visible.has(project));
  const retainedSet = new Set(retained);
  const added = unique
    .filter((project) => !retainedSet.has(project))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }));
  return [...retained, ...added];
}
