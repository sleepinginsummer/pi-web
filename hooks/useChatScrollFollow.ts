"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  getBottomScrollTop,
  getChatScrollFollowDecision,
  getDistanceToBottom,
  getInitialScrollTop,
  type ChatScrollDirection,
  type ChatScrollPositionRequest,
} from "@/lib/chat-scroll-position";

const BOTTOM_THRESHOLD_PX = 48;
const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);
const UP_SCROLL_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);


interface UseChatScrollFollowOptions {
  agentRunning: boolean;
  isStreaming: boolean;
  loading: boolean;
  messageCount: number;
  positionRequest: ChatScrollPositionRequest | null;
  streamingContent: unknown;
}

function useUserScrollFollow(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  attachmentKey: string,
) {
  const [isFollowing, setIsFollowing] = useState(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isFollowingRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const userScrollDirectionRef = useRef<ChatScrollDirection>("unknown");
  const lastTouchYRef = useRef<number | null>(null);
  const ignoreProgrammaticScrollUntilRef = useRef(0);

  const updateFollowing = useCallback((following: boolean) => {
    isFollowingRef.current = following;
    setIsFollowing(following);
  }, []);

  const updateNearBottom = useCallback((nearBottom: boolean) => {
    setIsNearBottom((current) => current === nearBottom ? current : nearBottom);
  }, []);

  const beginProgrammaticScroll = useCallback(() => {
    userScrollIntentUntilRef.current = 0;
    userScrollDirectionRef.current = "unknown";
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    updateFollowing(true);
  }, [updateFollowing]);

  const pauseFollowing = useCallback(() => updateFollowing(false), [updateFollowing]);
  const markNearBottom = useCallback(() => updateNearBottom(true), [updateNearBottom]);

  const markUserScrollIntent = useCallback((event: Event) => {
    let direction: ChatScrollDirection = "unknown";
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      direction = UP_SCROLL_KEYS.has(event.key) ? "up" : "down";
      updateFollowing(false);
    } else if (event instanceof WheelEvent) {
      direction = event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : "unknown";
      // 流式 token 会在下一帧继续跟随；滚动输入必须先同步暂停，避免被拉回底部。
      updateFollowing(false);
    } else if (event instanceof TouchEvent) {
      const touchY = event.touches[0]?.clientY;
      const previousTouchY = event.type === "touchstart" ? null : lastTouchYRef.current;
      if (typeof touchY === "number") {
        direction = previousTouchY === null
          ? "unknown"
          : touchY > previousTouchY ? "up" : touchY < previousTouchY ? "down" : "unknown";
        lastTouchYRef.current = touchY;
      }
      // 流式 token 会在下一帧继续跟随；滚动输入必须先同步暂停，避免被拉回底部。
      updateFollowing(false);
    }
    // 用户开始滚动后，之前的 smooth/instant 滚动事件都不再属于当前操作，
    // 否则它们可能在本次滚动的 scroll 回调中重新打开跟随。
    ignoreProgrammaticScrollUntilRef.current = 0;
    userScrollDirectionRef.current = direction;
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, [updateFollowing]);

  const syncScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distance = getDistanceToBottom(
      container.scrollHeight,
      container.clientHeight,
      container.scrollTop,
    );
    updateNearBottom(distance <= BOTTOM_THRESHOLD_PX);
    const decision = getChatScrollFollowDecision({
      distanceToBottom: distance,
      bottomThreshold: BOTTOM_THRESHOLD_PX,
      now: Date.now(),
      userScrollIntentUntil: userScrollIntentUntilRef.current,
      userScrollDirection: userScrollDirectionRef.current,
      ignoreProgrammaticScrollUntil: ignoreProgrammaticScrollUntilRef.current,
    });
    if (decision === "follow") updateFollowing(true);
    else if (decision === "pause") updateFollowing(false);
  }, [scrollContainerRef, updateFollowing, updateNearBottom]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("touchmove", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", syncScrollPosition, { passive: true });
    container.addEventListener("scrollend", syncScrollPosition, { passive: true });
    return () => {
      container.removeEventListener("pointerdown", markUserScrollIntent);
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("touchmove", markUserScrollIntent);
      container.removeEventListener("scroll", syncScrollPosition);
      container.removeEventListener("scrollend", syncScrollPosition);
    };
  }, [attachmentKey, markUserScrollIntent, scrollContainerRef, syncScrollPosition]);

  return { beginProgrammaticScroll, isFollowing, isFollowingRef, isNearBottom, markNearBottom, pauseFollowing, syncScrollPosition };
}

export function useChatScrollFollow({
  agentRunning,
  isStreaming,
  loading,
  messageCount,
  positionRequest,
  streamingContent,
}: UseChatScrollFollowOptions) {
  const lastRenderedMessageRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDoneRef = useRef(false);
  const handledPositionGenerationRef = useRef(0);
  const previousAgentRunningRef = useRef(agentRunning);
  const {
    beginProgrammaticScroll,
    isFollowing,
    isFollowingRef,
    isNearBottom,
    markNearBottom,
    pauseFollowing,
    syncScrollPosition,
  } = useUserScrollFollow(
    scrollContainerRef,
    `${loading}:${messageCount}`,
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    beginProgrammaticScroll();
    // 这是明确的“跳到最新”操作，先同步按钮状态，等待最终 scroll 事件校正实际位置。
    markNearBottom();
    container.scrollTo({
      top: getBottomScrollTop(container.scrollHeight, container.clientHeight),
      behavior,
    });
  }, [beginProgrammaticScroll, markNearBottom]);

  const scrollToInitialPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const lastMessage = lastRenderedMessageRef.current;
    beginProgrammaticScroll();
    if (!lastMessage) {
      container.scrollTop = getBottomScrollTop(container.scrollHeight, container.clientHeight);
      return;
    }
    // 初次打开会话时保留原有体验：短消息居中，长消息限制在可滚动范围内。
    const containerRect = container.getBoundingClientRect();
    const messageRect = lastMessage.getBoundingClientRect();
    container.scrollTop = getInitialScrollTop({
      containerHeight: container.clientHeight,
      containerScrollTop: container.scrollTop,
      containerTop: containerRect.top,
      messageHeight: messageRect.height,
      messageTop: messageRect.top,
      scrollHeight: container.scrollHeight,
    });
  }, [beginProgrammaticScroll]);

  const scrollUserMessageToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const element = lastUserMsgRef.current;
    if (!container || !element) return;
    const absoluteTop = element.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop;
    beginProgrammaticScroll();
    container.scrollTo({ top: absoluteTop - 16, behavior: "smooth" });
  }, [beginProgrammaticScroll]);

  // 流式消息高度变化时，浏览器不一定发出 scroll 事件；用内容尺寸变化
  // 重新校正“接近底部”和跟随状态，避免底部按钮停留在过期状态。
  useEffect(() => {
    if (!agentRunning || !isStreaming) return;
    const container = scrollContainerRef.current;
    const content = container?.firstElementChild;
    if (!container || !content) {
      syncScrollPosition();
      return;
    }

    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        syncScrollPosition();
      });
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleSync);
    observer?.observe(content);
    scheduleSync();
    return () => {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [agentRunning, isStreaming, messageCount, scrollContainerRef, syncScrollPosition]);

  useEffect(() => {
    const wasRunning = previousAgentRunningRef.current;
    previousAgentRunningRef.current = agentRunning;
    let layoutFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      layoutFrame = requestAnimationFrame(() => {
        const hasUnhandledPosition = positionRequest
          && positionRequest.generation > handledPositionGenerationRef.current;
        if (hasUnhandledPosition) {
          handledPositionGenerationRef.current = positionRequest.generation;
          initialScrollDoneRef.current = true;
          if (positionRequest.position === "user") scrollUserMessageToTop();
          else scrollToInitialPosition();
          return;
        }
        if (!initialScrollDoneRef.current && messageCount > 0) {
          initialScrollDoneRef.current = true;
          scrollToInitialPosition();
          return;
        }
        if (wasRunning && !agentRunning && isFollowingRef.current) {
          scrollToLatest("smooth");
          return;
        }
        if (agentRunning && isFollowingRef.current) scrollToLatest("instant");
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    };
  }, [agentRunning, isFollowingRef, messageCount, positionRequest, scrollToInitialPosition, scrollToLatest, scrollUserMessageToTop]);

  useEffect(() => {
    if (!agentRunning || !isStreaming) return;
    const frame = requestAnimationFrame(() => {
      syncScrollPosition();
      if (isFollowingRef.current) scrollToLatest("instant");
    });
    return () => cancelAnimationFrame(frame);
  }, [agentRunning, isFollowingRef, isStreaming, scrollToLatest, streamingContent, syncScrollPosition]);

  return {
    isFollowing,
    isNearBottom,
    lastRenderedMessageRef,
    lastUserMsgRef,
    pauseFollowing,
    scrollContainerRef,
    scrollToLatest,
  };
}
