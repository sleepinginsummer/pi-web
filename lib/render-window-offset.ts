/**
 * 聊天列表的虚拟渲染窗口只挂载最近的一段消息组。要跳到更早的一轮，必须先把
 * 窗口整体往前挪，否则目标组根本不在 DOM 里，滚动定位永远等不到节点。
 *
 * `offset` 是从末尾往回跳过的组数：0 表示最新的一段，
 * `total - groupIndex - maxGroups` 正好让目标组落在窗口顶部。
 * 找不到目标时返回 0，保持停在会话末尾。
 *
 * 全局搜索定位和历史大纲跳转共用这一个计算，避免两处漂移。
 */
export function windowOffsetForGroup(
  groupIndex: number | undefined,
  totalGroups: number,
  maxGroups: number,
): number {
  if (groupIndex === undefined || groupIndex < 0) return 0;
  return Math.max(0, totalGroups - groupIndex - maxGroups);
}
