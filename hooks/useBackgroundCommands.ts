"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundCommandListResponse } from "@/lib/types";

const IDLE_POLL_MS = 6000;
const BUSY_POLL_MS = 2000;

/** The project's background commands, polled while the tab is visible; faster while one runs. */
export function useBackgroundCommands(cwd: string | null | undefined) {
  const [data, setData] = useState<BackgroundCommandListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const request = ++requestRef.current;
    try {
      const response = await fetch(`/api/background-commands?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const next = await response.json() as BackgroundCommandListResponse & { error?: string };
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

  const busy = Boolean(data?.commands.some((command) => command.status === "running" || command.status === "stopping"));

  useEffect(() => {
    if (!cwd) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await refresh();
      if (!stopped) timer = setTimeout(tick, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
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
  }, [busy, cwd, refresh]);

  const act = useCallback(async (id: string, action: "stop" | "dismiss") => {
    setPending((current) => new Set(current).add(id));
    try {
      const response = await fetch(`/api/background-commands/${encodeURIComponent(id)}`, {
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

/** A command's latest output while its row is expanded; refreshed while it runs. */
export function useBackgroundCommandOutput(id: string | null, running: boolean) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const response = await fetch(`/api/background-commands/${encodeURIComponent(id)}/output?lines=60`, { cache: "no-store" });
        const body = await response.json() as { lines?: string[] };
        if (!stopped && Array.isArray(body.lines)) setLines(body.lines);
      } catch {
        // The next poll tries again.
      }
      if (!stopped && running) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, running]);
  return lines;
}
