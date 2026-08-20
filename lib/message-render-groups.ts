export interface MessageRenderGroup {
  start: number;
  end: number;
  finalAssistantIdx: number;
  isLiveTail: boolean;
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
