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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const requestGateRef = useRef(new LatestRequestGate());
  const initialLoadDoneRef = useRef(false);
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

    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions: SessionInfo[] };
      if (!requestGate.isLatest(requestKey, generation)) return;

      commitSessions(data.sessions);
      setError(null);
      if (!showInitialLoading) {
        setRefreshDone(true);
        if (refreshDoneTimerRef.current) clearTimeout(refreshDoneTimerRef.current);
        refreshDoneTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
      }
    } catch (cause) {
      if (requestGate.isLatest(requestKey, generation)) setError(String(cause));
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
