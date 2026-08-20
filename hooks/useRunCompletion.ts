"use client";

import { useCallback, useRef, useState } from "react";
import { RunCompletionController, type RunCompletionValue } from "@/lib/run-completion-controller";

export type RunCompletion = RunCompletionValue;

/**
 * 统一维护主运行的生命周期边界。
 * SSE 终止事件和状态对账都只能提交当前轮，且同一轮最多发布一次 completion。
 */
export function useRunCompletion() {
  const controllerRef = useRef<RunCompletionController | null>(null);
  if (!controllerRef.current) controllerRef.current = new RunCompletionController();
  const [completion, setCompletion] = useState<RunCompletion | null>(null);

  const beginRun = useCallback((runId: number) => {
    controllerRef.current?.beginRun(runId);
  }, []);

  const settleRun = useCallback((runId: number, sessionId: string | null): boolean => {
    const nextCompletion = controllerRef.current?.settleRun(runId, sessionId) ?? null;
    if (!nextCompletion) return false;
    setCompletion(nextCompletion);
    return true;
  }, []);

  return { completion, beginRun, settleRun };
}
