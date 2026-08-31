"use client";

import { useCallback, useEffect, useRef } from "react";
import { FrameBatcher, type FrameScheduler } from "@/lib/frame-batcher";

const browserFrameScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/** 将高频流事件合并到浏览器帧，并在会话身份变化时丢弃旧队列。 */
export function useFrameBatchedStreamDispatch<T>(
  dispatch: (items: T[]) => void,
  scopeKey: string | null,
) {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const batcherRef = useRef<FrameBatcher<T> | null>(null);
  if (!batcherRef.current) {
    batcherRef.current = new FrameBatcher<T>(
      (items) => dispatchRef.current(items),
      browserFrameScheduler,
    );
  }

  const enqueue = useCallback((item: T) => batcherRef.current?.enqueue(item), []);
  const flush = useCallback(() => batcherRef.current?.flush(), []);
  const reset = useCallback(() => batcherRef.current?.reset(), []);

  useEffect(() => {
    reset();
    return reset;
  }, [reset, scopeKey]);

  return { enqueue, flush, reset };
}
