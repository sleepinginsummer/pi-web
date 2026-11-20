"use client";

import { useCallback, useRef, useState } from "react";
import { usePolledJson } from "@/hooks/usePolledJson";
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
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // 操作可能在切项目之后才完成：错误提示只能落在发起它的那个项目上。
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // 轮询快慢看最近一次结果：ref 每次渲染更新，poller 的下一拍读它，
  // 于是「有服务在启动」时不必重启轮询、也不会多发一次请求。
  const latestRef = useRef<DevServerListResponse | null>(null);
  const busy = (data: DevServerListResponse | null) => pending.size > 0
    || Boolean(data?.servers.some((server) => server.status === "starting" || server.status === "stopping"));
  const { data, error, refresh, setError } = usePolledJson<DevServerListResponse>(
    cwd ? `/api/servers?cwd=${encodeURIComponent(cwd)}` : null,
    () => (busy(latestRef.current) ? BUSY_POLL_MS : IDLE_POLL_MS),
  );
  latestRef.current = data;

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setPending((current) => new Set(current).add(key));
    try {
      await action();
      // 同上：旧项目的成功不能清掉新项目的读取错误。
      if (cwdRef.current === cwd) setError(null);
    } catch (cause) {
      if (cwdRef.current === cwd) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      await refresh();
    }
  }, [refresh, setError]);

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
