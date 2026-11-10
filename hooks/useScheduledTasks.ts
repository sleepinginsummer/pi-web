"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledTaskListResponse } from "@/lib/types";

const POLL_MS = 5000;

/**
 * The project's scheduled tasks, polled while the tab is visible. Tasks are
 * created by the agent's tools and fired by the server, so there is no event
 * to wait for.
 */
export function useScheduledTasks(cwd: string | null | undefined) {
  const [data, setData] = useState<ScheduledTaskListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const request = ++requestRef.current;
    try {
      const response = await fetch(`/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const next = await response.json() as ScheduledTaskListResponse & { error?: string };
      if (request !== requestRef.current) return;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setData(next);
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [cwd]);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cwd, refresh]);

  const act = useCallback(async (id: string, action: "pause" | "resume" | "run" | "delete") => {
    setPending((current) => new Set(current).add(id));
    try {
      const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      await refresh();
    }
  }, [refresh]);

  return { data, error, pending, refresh, act };
}

/** A task that will still fire: enabled with a next run. */
export function isScheduledTaskPending(task: { enabled: boolean; nextRunAt: number | null }): boolean {
  return task.enabled && task.nextRunAt !== null;
}
