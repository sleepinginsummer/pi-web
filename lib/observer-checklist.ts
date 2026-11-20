export const OBSERVER_PRIORITIES = ["normal", "important", "urgent"] as const;
export type ObserverPriority = typeof OBSERVER_PRIORITIES[number];
export type ObserverItem = { id: string; title: string; done: boolean; priority: ObserverPriority; createdAt?: string };
export type ObserverEdit =
  | { action: "add"; item: ObserverItem }
  | { action: "update"; id: string; patch: Partial<Omit<ObserverItem, "id" | "createdAt">> }
  | { action: "delete"; id: string }
  | { action: "move"; id: string; beforeId: string | null };
const PRIORITY_RANK: Record<ObserverPriority, number> = { urgent: 0, important: 1, normal: 2 };

/** 将清单拆分为按重要程度排序的未完成项与保留原序的已完成项。 */
export function partitionObserverItems(items: readonly ObserverItem[]): { open: ObserverItem[]; done: ObserverItem[] } {
  const open: ObserverItem[] = [];
  const done: ObserverItem[] = [];
  for (const item of items) {
    if (item.done) done.push(item);
    else open.push(item);
  }
  open.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  return { open, done };
}

export function applyObserverEdit(items: ObserverItem[], edit: ObserverEdit): ObserverItem[] {
  if (edit.action === "add") return [...items, edit.item];
  const item = items.find(({ id }) => id === edit.id);
  if (!item) throw new Error("观察清单中没有该事项");
  if (edit.action === "delete") return items.filter(({ id }) => id !== edit.id);
  if (edit.action === "update") return items.map((entry) => entry === item ? { ...item, ...edit.patch } : entry);
  if (edit.beforeId === edit.id) return items;
  const next = items.filter(({ id }) => id !== edit.id);
  const index = edit.beforeId === null ? next.length : next.findIndex(({ id }) => id === edit.beforeId);
  if (index < 0) throw new Error("观察清单中没有指定的排序参照事项");
  next.splice(index, 0, item);
  return next;
}

export function parseObserverEdit(input: Record<string, unknown>, newId: () => string): ObserverEdit {
  const { action, id, title, done, priority, beforeId } = input;
  const patch: Partial<Omit<ObserverItem, "id" | "createdAt">> = {};
  if (action === "add" || action === "update") {
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim() || title.trim().length > 240) throw new Error("事项需要 1 至 240 字的标题");
      patch.title = title.trim();
    }
    if (done !== undefined) {
      if (typeof done !== "boolean") throw new Error("无效的勾选状态");
      patch.done = done;
    }
    if (priority !== undefined) {
      if (priority !== "normal" && priority !== "important" && priority !== "urgent") throw new Error("无效的重要程度");
      patch.priority = priority;
    }
  }
  if (action === "add" && patch.title) {
    return { action, item: { id: newId(), title: patch.title, done: patch.done ?? false, priority: patch.priority ?? "normal" } };
  }
  if (typeof id === "string" && id) {
    if (action === "update" && Object.keys(patch).length) return { action, id, patch };
    if (action === "delete") return { action, id };
    if (action === "move" && (beforeId === null || typeof beforeId === "string")) return { action, id, beforeId };
  }
  throw new Error("无效的观察清单操作");
}
