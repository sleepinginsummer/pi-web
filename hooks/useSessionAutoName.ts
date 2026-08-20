"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { runSessionTitleOperation } from "@/lib/session-title-operation-client";

export type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export function useSessionAutoName({
  applyGeneratedTitle,
  closeTopPanel,
  isActiveSession,
  onRefresh,
  sessionId,
  updateStatsTitle,
}: {
  applyGeneratedTitle: (sessionId: string, title: string) => boolean;
  closeTopPanel: () => void;
  isActiveSession: (sessionId: string) => boolean;
  onRefresh: () => void;
  sessionId: string | null;
  updateStatsTitle: (sessionId: string, title: string) => void;
}) {
  const [status, setStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus({ kind: "idle" });
  }, [sessionId]);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const generate = useCallback(async () => {
    if (!sessionId || status.kind === "naming") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    closeTopPanel();
    setStatus({ kind: "naming" });
    const operationId = crypto.randomUUID();
    try {
      const title = await runSessionTitleOperation({ sessionId, operationId });
      onRefresh();
      if (!applyGeneratedTitle(sessionId, title)) return;
      updateStatsTitle(sessionId, title);
      setStatus({ kind: "success" });
      timerRef.current = setTimeout(() => setStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (!isActiveSession(sessionId)) return;
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      timerRef.current = setTimeout(() => setStatus({ kind: "idle" }), 5000);
    }
  }, [applyGeneratedTitle, closeTopPanel, isActiveSession, onRefresh, sessionId, status.kind, updateStatsTitle]);

  return { generate, status };
}
