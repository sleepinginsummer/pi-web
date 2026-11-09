/** Pin 角标可选色；默认色不落盘，旧数据因此无需迁移。 */
export const SESSION_PIN_COLORS = {
  yellow: { background: "#eab308", foreground: "#713f12" },
  orange: { background: "#f97316", foreground: "#431407" },
  red: { background: "#ef4444", foreground: "#450a0a" },
  green: { background: "#22c55e", foreground: "#14532d" },
  blue: { background: "#3b82f6", foreground: "#082f49" },
  purple: { background: "#a855f7", foreground: "#3b0764" },
  pink: { background: "#ec4899", foreground: "#500724" },
  gray: { background: "#94a3b8", foreground: "#1e293b" },
} as const;

export type SessionPinColor = keyof typeof SESSION_PIN_COLORS;
export const DEFAULT_SESSION_PIN_COLOR: SessionPinColor = "yellow";
export const SESSION_PIN_COLOR_IDS = Object.keys(SESSION_PIN_COLORS) as SessionPinColor[];

export function isSessionPinColor(value: unknown): value is SessionPinColor {
  return typeof value === "string" && Object.hasOwn(SESSION_PIN_COLORS, value);
}

export interface SidebarPreferences {
  version: 1;
  revision: number;
  legacyMigrationCompleted: boolean;
  projectOrder: string[];
  sessionOrder: string[];
  pinnedSessionIds: string[];
  /** 只保存已 Pin 且非默认色的会话。 */
  sessionPinColors: Record<string, SessionPinColor>;
}

export type SidebarPreferenceAction =
  | { type: "move_project"; source: string; target: string; visibleIds: string[] }
  | { type: "move_session"; source: string; target: string; visibleIds: string[] }
  | { type: "set_session_pinned"; sessionId: string; pinned: boolean }
  | { type: "set_session_pin_color"; sessionId: string; color: SessionPinColor }
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
    sessionOrder: [],
    pinnedSessionIds: [],
    sessionPinColors: {},
  };
}

function withoutPinColors(colors: Record<string, SessionPinColor>, ids: string[]): Record<string, SessionPinColor> {
  const removed = new Set(ids);
  return Object.fromEntries(Object.entries(colors).filter(([id]) => !removed.has(id)));
}

function parseSessionPinColors(value: unknown, pinnedSessionIds: string[]): Record<string, SessionPinColor> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const pinned = new Set(pinnedSessionIds);
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, SessionPinColor] => (
    pinned.has(entry[0]) && isSessionPinColor(entry[1]) && entry[1] !== DEFAULT_SESSION_PIN_COLOR
  )));
}

export function parseSidebarPreferences(value: unknown): SidebarPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptySidebarPreferences();
  const raw = value as Partial<SidebarPreferences>;
  const pinnedSessionIds = uniquePreferenceIds(raw.pinnedSessionIds);
  return {
    version: 1,
    revision: Number.isSafeInteger(raw.revision) && (raw.revision ?? -1) >= 0 ? raw.revision! : 0,
    legacyMigrationCompleted: raw.legacyMigrationCompleted === true,
    projectOrder: uniquePreferenceIds(raw.projectOrder),
    sessionOrder: uniquePreferenceIds(raw.sessionOrder),
    pinnedSessionIds,
    sessionPinColors: parseSessionPinColors(raw.sessionPinColors, pinnedSessionIds),
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
    if (sameIds(projectOrder, current.projectOrder)) return current;
    return { ...current, revision: current.revision + (incrementRevision ? 1 : 0), projectOrder };
  }
  if (action.type === "remove_sessions") {
    const sessionOrder = removeIds(current.sessionOrder, action.ids);
    const pinnedSessionIds = removeIds(current.pinnedSessionIds, action.ids);
    if (sameIds(sessionOrder, current.sessionOrder) && sameIds(pinnedSessionIds, current.pinnedSessionIds)) return current;
    return { ...current, revision: current.revision + (incrementRevision ? 1 : 0), sessionOrder, pinnedSessionIds, sessionPinColors: withoutPinColors(current.sessionPinColors, action.ids) };
  }
  if (action.type === "set_session_pin_color") {
    const previous = Object.hasOwn(current.sessionPinColors, action.sessionId) ? current.sessionPinColors[action.sessionId] : DEFAULT_SESSION_PIN_COLOR;
    if (!current.pinnedSessionIds.includes(action.sessionId) || previous === action.color) return current;
    const sessionPinColors = withoutPinColors(current.sessionPinColors, [action.sessionId]);
    return {
      ...current,
      revision: current.revision + (incrementRevision ? 1 : 0),
      sessionPinColors: action.color === DEFAULT_SESSION_PIN_COLOR ? sessionPinColors : { ...sessionPinColors, [action.sessionId]: action.color },
    };
  }
  const next = { ...current, revision: current.revision + (incrementRevision ? 1 : 0) };
  switch (action.type) {
    case "move_project":
      next.projectOrder = moveVisibleItem(current.projectOrder, action.visibleIds, action.source, action.target);
      break;
    case "move_session":
      next.sessionOrder = moveVisibleItem(current.sessionOrder, action.visibleIds, action.source, action.target);
      break;
    case "set_session_pinned":
      next.pinnedSessionIds = setPinned(current.pinnedSessionIds, action.sessionId, action.pinned);
      // 取消 Pin 后颜色不保留，再次 Pin 回到默认色。
      if (!action.pinned) next.sessionPinColors = withoutPinColors(current.sessionPinColors, [action.sessionId]);
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
  // 未登记的新增项目排在顶部，已有项目继续沿用用户保存的顺序。
  return [...added, ...retained];
}
