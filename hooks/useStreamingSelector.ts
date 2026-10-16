"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";
import { getDisplayableAssistantBlocks } from "@/lib/message-display";

/**
 * 只订阅展示所需的值。select 必须保持稳定；普通 state 更新保留 React 批处理，
 * 相同的选择值不派发更新，避免正文增量触发聊天窗口和输入框重渲。
 */
export function useStreamingSelector<T>(store: StreamingStore, select: (state: StreamingState) => T): T {
  const [value, setValue] = useState(() => select(store.getState()));
  const selectedRef = useRef(value);
  useLayoutEffect(() => {
    const update = () => {
      const next = select(store.getState());
      if (Object.is(selectedRef.current, next)) return;
      selectedRef.current = next;
      setValue(next);
    };
    // 补上 render 到订阅之间到达的增量，切换 store 时也读取新身份的快照。
    update();
    return store.subscribe(update);
  }, [store, select]);
  return value;
}

export const selectIsStreaming = (state: StreamingState) => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState) => Boolean(state.streamingMessage?.content.length);
export const selectStreamingMessage = (state: StreamingState) => state.streamingMessage;
// fork 的运行中过程窗口按块计数，只在块增删时重排历史，正文增量不参与父组件渲染。
export const selectStreamingBlockCount = (state: StreamingState) => state.isStreaming && state.streamingMessage
  ? getDisplayableAssistantBlocks(state.streamingMessage, { isStreaming: true }).length
  : 0;
