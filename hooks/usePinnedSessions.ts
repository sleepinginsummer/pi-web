"use client";

import { useCallback, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";

const STORAGE_KEY = "pi-web:pinned-session-ids";

function loadPinnedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistPinnedIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage 不可用时仅保留当前页面状态。
  }
}

/** 保存仅属于当前浏览器的会话标记，并过滤已经不存在的会话。 */
export function usePinnedSessions(sessions: SessionInfo[]) {
  const [storedIds, setStoredIds] = useState<Set<string>>(loadPinnedIds);
  const existingIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const pinnedIds = useMemo(
    () => new Set([...storedIds].filter((id) => existingIds.has(id))),
    [existingIds, storedIds],
  );

  const togglePinned = useCallback((sessionId: string) => {
    setStoredIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      persistPinnedIds(next);
      return next;
    });
  }, []);

  return { pinnedIds, togglePinned };
}
