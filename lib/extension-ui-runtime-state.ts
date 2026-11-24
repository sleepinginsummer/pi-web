/**
 * 快照负责补齐未收到实时事件的键；请求发出后改动过的键保留当前值。
 * 删除也必须保留版本记录：当前列表没有该键，不代表旧快照可以将它恢复。
 */
export function mergeExtensionUiSnapshot<T extends { key: string }>(
  current: T[],
  incoming: T[] | undefined,
  keyRevisions: ReadonlyMap<string, number>,
  readRevision: number | undefined,
): T[] {
  const snapshot = incoming ?? [];
  if (readRevision === undefined || keyRevisions.size === 0) return snapshot;
  const changed = (key: string) => (keyRevisions.get(key) ?? 0) > readRevision;
  return [
    ...snapshot.filter(item => !changed(item.key)),
    ...current.filter(item => changed(item.key)),
  ];
}
