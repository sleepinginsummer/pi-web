"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { pruneSessionContextCache } from "@/lib/session-load-client";
import type { SessionInfo } from "@/lib/types";

interface UseSessionListOptions {
  refreshKey?: number;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface UseSessionListResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  refreshDone: boolean;
  loadSessions: (showInitialLoading?: boolean) => Promise<void>;
  removeSessions: (sessionIds: Iterable<string>) => void;
}

export function useSessionList({ refreshKey, onSessionsChange }: UseSessionListOptions): UseSessionListResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>([]);
  const directoryVersionRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const requestGateRef = useRef(new LatestRequestGate());
  const initialLoadDoneRef = useRef(false);
  const summaryLoadedRef = useRef(false);
  const refreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSessionsChangeRef = useRef(onSessionsChange);
  onSessionsChangeRef.current = onSessionsChange;

  const commitSessions = useCallback((nextSessions: SessionInfo[]) => {
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    onSessionsChangeRef.current?.(nextSessions);
    pruneSessionContextCache(nextSessions.map((session) => session.id));
  }, []);

  const removeSessions = useCallback((sessionIds: Iterable<string>) => {
    const removedIds = new Set(sessionIds);
    if (removedIds.size === 0) return;
    requestGateRef.current.invalidate("session-list");
    commitSessions(sessionsRef.current.filter((session) => !removedIds.has(session.id)));
  }, [commitSessions]);

  const loadSessions = useCallback(async (showInitialLoading = false) => {
    const requestKey = "session-list";
    const requestGate = requestGateRef.current;
    const generation = requestGate.begin(requestKey);
    if (showInitialLoading) setLoading(true);
    const summary = showInitialLoading && !summaryLoadedRef.current;

    try {
      const params = new URLSearchParams();
      if (summary) params.set("summary", "1");
      else if (directoryVersionRef.current !== null) params.set("since", String(directoryVersionRef.current));
      const response = await fetch(`/api/sessions${params.size > 0 ? `?${params}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as {
        sessions?: SessionInfo[];
        upserts?: SessionInfo[];
        removed?: string[];
        sessionDirectoryVersion?: number;
      };
      if (!requestGate.isLatest(requestKey, generation)) return;

      const nextSessions = data.sessions ?? (() => {
        const removed = new Set(data.removed ?? []);
        const byId = new Map(sessionsRef.current.filter((session) => !removed.has(session.id)).map((session) => [session.id, session]));
        for (const session of data.upserts ?? []) byId.set(session.id, session);
        return [...byId.values()].sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
      })();
      if (summary) {
        // 摘要和完整列表不能共享增量版本，完整扫描必须重新取全量。
        summaryLoadedRef.current = true;
        directoryVersionRef.current = null;
      } else if (typeof data.sessionDirectoryVersion === "number") {
        directoryVersionRef.current = data.sessionDirectoryVersion;
      }
      commitSessions(nextSessions);
      setError(null);
      if (summary) queueMicrotask(() => void loadSessions(false));
      if (!showInitialLoading) {
        setRefreshDone(true);
        if (refreshDoneTimerRef.current) clearTimeout(refreshDoneTimerRef.current);
        refreshDoneTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
      }
    } catch (cause) {
      if (requestGate.isLatest(requestKey, generation)) {
        if (summary) {
          // 摘要不可用时仍尝试完整列表，不让首屏卡在失败状态。
          summaryLoadedRef.current = true;
          queueMicrotask(() => void loadSessions(false));
        } else setError(String(cause));
      }
    } finally {
      // 后发的静默刷新也必须结束首次 loading，否则旧请求失效后无人清理加载态。
      if (requestGate.isLatest(requestKey, generation)) setLoading(false);
      requestGate.finish(requestKey);
    }
  }, [commitSessions]);

  useEffect(() => {
    const isFirstLoad = !initialLoadDoneRef.current;
    initialLoadDoneRef.current = true;
    void loadSessions(isFirstLoad);
  }, [loadSessions, refreshKey]);

  useEffect(() => () => {
    requestGateRef.current.invalidate("session-list");
    if (refreshDoneTimerRef.current) clearTimeout(refreshDoneTimerRef.current);
  }, []);

  return {
    sessions,
    loading,
    error,
    refreshDone,
    loadSessions,
    removeSessions,
  };
}
