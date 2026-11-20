"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePolledJson } from "@/hooks/usePolledJson";
import type { ScheduledTaskListResponse } from "@/lib/types";

const POLL_MS = 5000;

/**
 * The project's scheduled tasks, polled while the tab is visible. Tasks are
 * created by the agent's tools and fired by the server, so there is no event
 * to wait for.
 */
export function useScheduledTasks(cwd: string | null | undefined) {
  // 操作失败单独记：轮询刷新只清读取错误，不该把「删除失败」这类提示一并抹掉。
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // 操作可能在切项目之后才完成：错误提示只能落在发起它的那个项目上。
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const { data, error, refresh } = usePolledJson<ScheduledTaskListResponse>(
    cwd ? `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}` : null,
    POLL_MS,
  );

  useEffect(() => {
    setActionError(null);
  }, [cwd]);

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
      // 成功也只清自己项目的提示：A 的删除成功不能抹掉 B 刚出现的失败。
      if (cwdRef.current === cwd) setActionError(null);
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

/** A task that will still fire: enabled with a next run. */
export function isScheduledTaskPending(task: { enabled: boolean; nextRunAt: number | null }): boolean {
  return task.enabled && task.nextRunAt !== null;
}
