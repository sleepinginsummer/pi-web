"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  SessionListRefreshCoordinator,
  type SessionListRefreshRequest,
} from "@/lib/session-list-refresh-coordinator";

const browserScheduler = {
  set: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
  clear: (handle: unknown) => window.clearTimeout(handle as number),
};

/** 在 AppShell 生命周期内合并完整会话列表刷新请求。 */
export function useSessionListRefreshCoordinator(refresh: () => void) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const coordinatorRef = useRef<SessionListRefreshCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new SessionListRefreshCoordinator(
      () => refreshRef.current(),
      browserScheduler,
    );
  }

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    return () => coordinator?.dispose();
  }, []);
  return useCallback((request: SessionListRefreshRequest) => {
    coordinatorRef.current?.request(request);
  }, []);
}
