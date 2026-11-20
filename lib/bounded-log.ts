/**
 * 输出日志的截断策略：超过上限时一次裁掉一大截，而不是每追加一行就 `shift()`。
 *
 * `Array.prototype.shift()` 每次都要把剩下的元素整体往前搬，刷屏的服务端日志下
 * 每行都是 O(N)，会直接吃掉服务端主线程。这里保留「写入后检查、超限就裁到低水位」，
 * 让一次搬运分摊到很多行上。
 */
export const LOG_TRIM_RATIO = 0.75;

/**
 * 把 `entries` 的开头裁到剩余字符数不超过 `maxChars * LOG_TRIM_RATIO`。
 *
 * 返回裁剪后的字符总数（调用方把它写回自己的计数器）。至少保留一条：一次超大的
 * 输出片段不该把记录裁成空数组。
 */
export function trimLogPrefix<T>(
  entries: T[],
  chars: number,
  maxChars: number,
  lengthOf: (entry: T) => number,
): number {
  if (chars <= maxChars) return chars;
  const target = Math.floor(maxChars * LOG_TRIM_RATIO);
  const needed = chars - target;
  let dropped = 0;
  let drop = 0;
  while (dropped < needed && drop < entries.length - 1) {
    dropped += lengthOf(entries[drop]);
    drop += 1;
  }
  if (drop > 0) entries.splice(0, drop);
  return chars - dropped;
}
