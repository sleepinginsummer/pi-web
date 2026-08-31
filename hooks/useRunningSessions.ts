"use client";

import { useCallback, useEffect, useState } from "react";
import { stabilizeStringSet } from "@/lib/stable-string-set";

const RUNNING_SESSIONS_POLL_MS = 2500;

/** 轮询运行会话，并在服务端集合未变化时保持 Set 引用稳定。 */
export function useRunningSessions() {
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());

  const commitSnapshot = useCallback((ids: string[]) => {
    setRunningSessionIds((current) => stabilizeStringSet(current, ids));
  }, []);


  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const response = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!response.ok) return;
        const data = await response.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        commitSnapshot(data.runningSessionIds ?? []);
      } catch {
        // 保留最后一次成功状态；下一个可见页轮询会重试。
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [commitSnapshot]);

  return { runningSessionIds };
}
