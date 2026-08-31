/** 内容未变化时复用原 Set；变化时返回新的快照引用。 */
export function stabilizeStringSet(current: Set<string>, values: Iterable<string>): Set<string> {
  const next = new Set(values);
  if (current.size !== next.size) return next;
  for (const value of current) {
    if (!next.has(value)) return next;
  }
  return current;
}
