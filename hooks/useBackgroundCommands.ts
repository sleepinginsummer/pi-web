"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePolledJson } from "@/hooks/usePolledJson";
import type { BackgroundCommandListResponse } from "@/lib/types";

const IDLE_POLL_MS = 6000;
const BUSY_POLL_MS = 2000;

/** The project's background commands, polled while the tab is visible; faster while one runs. */
export function useBackgroundCommands(cwd: string | null | undefined) {
  // 操作失败单独记：轮询刷新只清读取错误，不该把「移除失败」这类提示一并抹掉。
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // 操作可能在切项目之后才完成：错误提示只能落在发起它的那个项目上。
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const latestRef = useRef<BackgroundCommandListResponse | null>(null);
  const busy = Boolean(latestRef.current?.commands.some((command) => command.status === "running" || command.status === "stopping"));
  const { data, error, refresh } = usePolledJson<BackgroundCommandListResponse>(
    cwd ? `/api/background-commands?cwd=${encodeURIComponent(cwd)}` : null,
    () => (busy ? BUSY_POLL_MS : IDLE_POLL_MS),
  );
  latestRef.current = data;

  useEffect(() => {
    setActionError(null);
  }, [cwd]);

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
      setActionError(null);
    } catch (cause) {
      if (cwdRef.current === cwd) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      await refresh();
    }
  }, [refresh]);

  return { data, error, actionError, pending, refresh, act };
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
