export type ChatScrollPosition = "initial" | "user" | "running-end";

export interface ChatScrollPositionRequest {
  generation: number;
  position: ChatScrollPosition;
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

export interface InitialScrollPosition {
  containerHeight: number;
  containerScrollTop: number;
  containerTop: number;
  messageHeight: number;
  messageTop: number;
  scrollHeight: number;
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

export function getInitialScrollTop(position: InitialScrollPosition): number {
  const {
    containerHeight,
    containerScrollTop,
    containerTop,
    messageHeight,
    messageTop,
    scrollHeight,
  } = position;
  const desiredTop = containerScrollTop
    + messageTop
    - containerTop
    - (containerHeight - messageHeight) / 2;
  return Math.max(0, Math.min(desiredTop, getBottomScrollTop(scrollHeight, containerHeight)));
}
