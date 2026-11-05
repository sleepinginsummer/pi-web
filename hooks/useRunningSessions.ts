"use client";

import { useCallback, useEffect, useState } from "react";
import { noteRunningPoll } from "@/lib/page-debug";
import { stabilizeStringSet } from "@/lib/stable-string-set";

const RUNNING_SESSIONS_POLL_MS = 2500;

/** 轮询运行会话，并在服务端集合未变化时保持 Set 引用稳定。 */
export function useRunningSessions() {
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  // 运行中但停在扩展阻塞对话框上的会话（select/confirm/input/editor/自定义面板），侧栏显示为等待输入。
  const [awaitingInputSessionIds, setAwaitingInputSessionIds] = useState<Set<string>>(() => new Set());
  // 首条消息还在等待初始化的会话及其正文，侧栏显示“创建会话中”。
  const [startingSessions, setStartingSessions] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Sessions whose subagents can still report back with a run there: not done yet (#1434).
  const [subagentsActiveSessionIds, setSubagentsActiveSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionListVersion, setSessionListVersion] = useState<number | null>(null);

  const commitSnapshot = useCallback((ids: string[], awaitingIds: string[], subagentsActiveIds: string[]) => {
    setRunningSessionIds((current) => stabilizeStringSet(current, ids));
    setAwaitingInputSessionIds((current) => stabilizeStringSet(current, awaitingIds));
    setSubagentsActiveSessionIds((current) => stabilizeStringSet(current, subagentsActiveIds));
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
      // The debug panel's record of this poll: the request alone, up to its answer.
      const startedAt = Date.now();
      let answeredAt: number | null = null;
      let outcome: "ok" | "error" | "aborted" = "error";
      let httpStatus: number | null = null;
      try {
        const response = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        httpStatus = response.status;
        if (!response.ok) return;
        outcome = "ok";
        const data = await response.json() as {
          runningSessionIds?: string[];
          awaitingInputSessionIds?: string[];
          startingSessions?: Array<{ sessionId: string; firstMessage: string }>;
          subagentsActiveSessionIds?: string[];
          sessionListVersion?: number;
        };
        answeredAt = Date.now();
        if (stopped || controller !== current) return;
        commitSnapshot(data.runningSessionIds ?? [], data.awaitingInputSessionIds ?? [], data.subagentsActiveSessionIds ?? []);
        const starting = data.startingSessions ?? [];
        // 内容不变时保持引用稳定，轮询不重渲染整棵侧栏。
        setStartingSessions((previous) => previous.size === starting.length
          && starting.every(({ sessionId, firstMessage }) => previous.get(sessionId) === firstMessage)
          ? previous
          : new Map(starting.map(({ sessionId, firstMessage }) => [sessionId, firstMessage])));
        if (typeof data.sessionListVersion === "number") setSessionListVersion(data.sessionListVersion);
      } catch {
        // 保留最后一次成功状态；下一个可见页轮询会重试。
        outcome = current.signal.aborted ? "aborted" : "error";
      } finally {
        if (controller === current) controller = null;
        schedule();
        noteRunningPoll(startedAt, outcome, httpStatus, answeredAt);
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

  return { runningSessionIds, awaitingInputSessionIds, startingSessions, subagentsActiveSessionIds, sessionListVersion };
}
