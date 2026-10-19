"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DevServerListResponse, DevServerSnapshot } from "@/lib/types";

const IDLE_POLL_MS = 4000;
const BUSY_POLL_MS = 1000;

export function isDevServerActive(server: Pick<DevServerSnapshot, "status">): boolean {
  return server.status === "starting" || server.status === "running" || server.status === "stopping";
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }
}

/**
 * The project's dev servers, polled while the tab is visible. Servers are
 * started by the agent's tools on the server, so there is no event to wait
 * for; polling speeds up while any server is starting or stopping.
 */
export function useDevServers(cwd: string | null | undefined) {
  const [data, setData] = useState<DevServerListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const request = ++requestRef.current;
    try {
      const response = await fetch(`/api/servers?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const next = await response.json() as DevServerListResponse & { error?: string };
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

  const busy = Boolean(data?.servers.some((server) => server.status === "starting" || server.status === "stopping"))
    || pending.size > 0;

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

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setPending((current) => new Set(current).add(key));
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      await refresh();
    }
  }, [refresh]);

  const start = useCallback((name: string) => run(`start:${name}`, () => postJson("/api/servers", { cwd, name })), [cwd, run]);
  const stop = useCallback((id: string) => run(id, () => postJson(`/api/servers/${encodeURIComponent(id)}`, { action: "stop" })), [run]);
  const dismiss = useCallback((id: string) => run(id, () => postJson(`/api/servers/${encodeURIComponent(id)}`, { action: "dismiss" })), [run]);

  return { data, error, pending, refresh, start, stop, dismiss };
}

/**
 * The address a browser tab can open. A server declared on localhost is
 * reached through the host pi-web was opened on, so a phone on the LAN gets
 * the dev machine instead of itself.
 */
export function browserServerUrl(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    const parsed = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
    const here = window.location.hostname;
    if (loopback && here && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(here)) parsed.hostname = here;
    return parsed.toString();
  } catch {
    return url;
  }
}
