export interface MessageRenderGroup {
  start: number;
  end: number;
  finalAssistantIdx: number;
  isLiveTail: boolean;
}

export interface RecentItemWindow {
  hiddenCount: number;
  visibleOffsets: number[];
}

/**
 * 从多个有序来源的末尾分配可见项；offset 等于来源项数时表示该来源完全隐藏。
 * 调用方据此在创建 JSX 前裁掉旧处理项，避免折叠内容继续参与渲染。
 */
export function buildRecentItemWindow(itemCounts: number[], limit: number): RecentItemWindow {
  const normalizedCounts = itemCounts.map((count) => Math.max(0, Math.floor(count)));
  const visibleOffsets = [...normalizedCounts];
  let remaining = Math.max(0, Math.floor(limit));
  let visibleCount = 0;

  for (let index = normalizedCounts.length - 1; index >= 0 && remaining > 0; index--) {
    const count = normalizedCounts[index];
    const sourceVisibleCount = Math.min(count, remaining);
    visibleOffsets[index] = count - sourceVisibleCount;
    remaining -= sourceVisibleCount;
    visibleCount += sourceVisibleCount;
  }

  const totalCount = normalizedCounts.reduce((sum, count) => sum + count, 0);
  return { hiddenCount: totalCount - visibleCount, visibleOffsets };
}

/** 只生成索引描述，不创建 JSX；调用方可先截取可见窗口再物化消息组件。 */
export function buildMessageRenderGroups<T>(
  messages: T[],
  options: {
    isAnchor: (message: T) => boolean;
    findFinalAssistantIndex: (messages: T[], start: number, end: number) => number;
    busy: boolean;
    lastAnchorIndex: number;
  },
): { groups: MessageRenderGroup[]; liveTailStartIndex: number | null } {
  const groups: MessageRenderGroup[] = [];
  let liveTailStartIndex: number | null = null;
  for (let index = 0; index < messages.length;) {
    if (!options.isAnchor(messages[index])) {
      groups.push({ start: index, end: index + 1, finalAssistantIdx: -1, isLiveTail: false });
      index += 1;
      continue;
    }
    const start = index;
    let end = start + 1;
    while (end < messages.length && !options.isAnchor(messages[end])) end += 1;
    const finalAssistantIdx = options.findFinalAssistantIndex(messages, start, end);
    const isLiveTail = options.busy && end === messages.length && start === options.lastAnchorIndex;
    if (isLiveTail) liveTailStartIndex = groups.length;
    groups.push({ start, end, finalAssistantIdx, isLiveTail });
    index = end;
  }
  return { groups, liveTailStartIndex };
}
