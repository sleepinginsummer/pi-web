import { useCallback, useLayoutEffect, useRef } from "react";

export const RUN_END_CLICK_GUARD_MS = 600;

/**
 * When a run ends, Compact (and the tools button) take the place Stop held in
 * the controls row, so the second click of a double click on Stop, or a click
 * aimed at Stop just as the run ends, lands on them. Such a pointer click is
 * ignored; a keyboard one (Enter/Space, `detail` 0) never is.
 */
export function isRunEndStrayClick(detail: number, msSinceRunEnd: number): boolean {
  return detail > 0 && msSinceRunEnd < RUN_END_CLICK_GUARD_MS;
}

/**
 * 返回稳定的判定函数：运行结束（isStreaming 由 true 变 false）后的一小段时间内，
 * 落在原 Stop 位置上的指针点击视为误触。结束时刻在 Stop 被替换的同一次提交中记录。
 */
export function useRunEndStrayClick(isStreaming: boolean): (event: { detail: number }) => boolean {
  const runEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  useLayoutEffect(() => {
    if (!isStreaming) return;
    return () => { runEndedAtRef.current = performance.now(); };
  }, [isStreaming]);
  return useCallback(
    (event: { detail: number }) => isRunEndStrayClick(event.detail, performance.now() - runEndedAtRef.current),
    [],
  );
}
