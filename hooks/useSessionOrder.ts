"use client";

import { useCallback, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";

const STORAGE_KEY = "pi-web:session-order";

function loadOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function persistOrder(order: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // localStorage 不可用时仅放弃持久化，本次拖曳顺序仍然有效。
  }
}

/** 保持手动顺序稳定，并把尚未排序的新会话按创建时间倒序放到顶部。 */
function reconcileOrder(sessions: SessionInfo[], storedOrder: string[]): string[] {
  const existingIds = new Set(sessions.map((session) => session.id));
  const retained = storedOrder.filter((id) => existingIds.has(id));
  const retainedIds = new Set(retained);
  const added = sessions
    .filter((session) => !retainedIds.has(session.id))
    .sort((left, right) => right.created.localeCompare(left.created))
    .map((session) => session.id);
  return [...added, ...retained];
}

export function useSessionOrder(sessions: SessionInfo[]) {
  const [storedOrder, setStoredOrder] = useState<string[]>(loadOrder);
  const order = useMemo(() => reconcileOrder(sessions, storedOrder), [sessions, storedOrder]);

  const moveSession = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setStoredOrder((current) => {
      const reconciled = reconcileOrder(sessions, current);
      const sourceIndex = reconciled.indexOf(sourceId);
      const targetIndex = reconciled.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;

      const next = [...reconciled];
      next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceId);
      persistOrder(next);
      return next;
    });
  }, [sessions]);

  return { order, moveSession };
}
