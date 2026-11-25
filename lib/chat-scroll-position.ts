export interface ChatEntryScrollPosition {
  entryId: string;
}

export type ChatScrollPosition = "initial" | "user" | "running-end" | ChatEntryScrollPosition;

export type ChatReadingPosition =
  | { atBottom: true }
  | {
      atBottom: false;
      anchorEntryId: string;
      anchorOffset: number;
      /** 同一消息拆成多个正文片段时，用片段标识区分恢复目标。 */
      anchorPart?: string;
      oldestEntryId: string | null;
    };

export interface ChatScrollAnchorCandidate {
  entryId: string;
  part?: string;
  top: number;
  bottom: number;
}

export interface ChatScrollPositionRequest {
  generation: number;
  position: ChatScrollPosition;
}

/**
 * 定位本次压缩卡片。读取器已把它放回时间线（通常就是末尾）；取最后一张可见卡片，
 * 避免命中更早的旧摘要。
 */
export function getCompactionScrollPosition(
  messages: readonly { role: string; customType?: string; display?: boolean }[],
  entryIds: readonly string[],
): ChatEntryScrollPosition | null {
  const index = messages.findLastIndex((message) => (
    message.role === "custom" && message.customType === "compaction" && message.display === true
  ));
  const entryId = entryIds[index];
  return entryId ? { entryId } : null;
}

export type ChatScrollFollowDecision = "follow" | "pause" | "keep";
export type ChatScrollDirection = "up" | "down" | "unknown";

/**
 * 用户滚动期间，必须优先保留用户意图，不能被流式内容触发的滚动事件覆盖。
 */
export function getChatScrollFollowDecision(options: {
  distanceToBottom: number;
  bottomThreshold: number;
  now: number;
  userScrollIntentUntil: number;
  userScrollDirection: ChatScrollDirection;
  ignoreProgrammaticScrollUntil: number;
}): ChatScrollFollowDecision {
  if (options.now < options.userScrollIntentUntil) {
    if (options.userScrollDirection === "up") return "pause";
    if (options.distanceToBottom <= options.bottomThreshold) return "follow";
    return "pause";
  }
  if (options.now < options.ignoreProgrammaticScrollUntil) return "keep";
  if (options.distanceToBottom <= options.bottomThreshold) return "follow";
  return "keep";
}

export function getBottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function getDistanceToBottom(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
): number {
  return Math.max(0, getBottomScrollTop(scrollHeight, clientHeight) - scrollTop);
}

export function findChatScrollAnchor(
  candidates: ChatScrollAnchorCandidate[],
  viewportTop: number,
): Pick<Extract<ChatReadingPosition, { atBottom: false }>, "anchorEntryId" | "anchorOffset" | "anchorPart"> | null {
  let candidate = candidates[0];
  for (const item of candidates) {
    if (item.top > viewportTop) break;
    candidate = item;
  }
  if (!candidate) return null;
  return {
    anchorEntryId: candidate.entryId,
    anchorOffset: candidate.top - viewportTop,
    ...(candidate.part ? { anchorPart: candidate.part } : {}),
  };
}

/** 优先恢复同一消息的同一正文片段；旧位置或片段已移除时仍按消息恢复。 */
export function findChatScrollRestoreTarget<T extends Pick<ChatScrollAnchorCandidate, "entryId" | "part">>(
  candidates: T[],
  position: { anchorEntryId: string; anchorPart?: string },
): T | undefined {
  const matching = candidates.filter((candidate) => candidate.entryId === position.anchorEntryId);
  return (position.anchorPart ? matching.find((candidate) => candidate.part === position.anchorPart) : undefined)
    ?? matching[0];
}
