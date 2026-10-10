"use client";

import { useEffect, useRef } from "react";
import type { AgentRuntimeSnapshot } from "@/lib/agent-state";
import { fetchRuntimeState } from "@/lib/session-load-client";

/** 等待扩展绑定时的兜底轮询间隔；绑定完成事件（SSE）才是快路径。 */
export const SESSION_BINDING_POLL_INTERVAL_MS = 3_000;

/**
 * 等待扩展绑定的总期限。服务端的 20s 上限只作用于"某条命令的等待"，
 * 后台绑定本身可以一直不结束；没有总期限，界面就会永久停在初始化中。
 */
export const SESSION_BINDING_DEADLINE_MS = 60_000;

/**
 * 串行轮询器：上一次读取返回后才排下一次，任何时刻最多一个在途请求，
 * `stop()` 会取消在途读取并停止后续调度。
 *
 * 连接被占满时请求会长时间排队，如果按固定间隔无条件发请求就会不断叠加，
 * 反而加重排队；这里用"完成后再排下一次"避免自激。
 */
export function createSerialPoller<T>(options: {
  intervalMs: number;
  read: (signal: AbortSignal) => Promise<T>;
  onResult: (value: T) => void;
  onError?: (error: unknown) => void;
  /** 总期限（毫秒）。到期只回调一次，随后停止轮询；不传表示不限时。 */
  deadlineMs?: number;
  onDeadline?: () => void;
}): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let stopped = true;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), options.intervalMs);
  };
  const run = async () => {
    if (stopped) return;
    timer = null;
    controller = new AbortController();
    try {
      const value = await options.read(controller.signal);
      if (!stopped) options.onResult(value);
    } catch (error) {
      if (!stopped) options.onError?.(error);
    } finally {
      controller = null;
      schedule();
    }
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      if (options.deadlineMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          // 到期：停掉后续调度与在途读取，再通知调用方收敛（保留身份的重试由调用方决定）。
          stop();
          options.onDeadline?.();
        }, options.deadlineMs);
      }
      schedule();
    },
    stop(): void {
      stop();
    },
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    controller?.abort();
    controller = null;
  }
}

/**
 * 等待扩展绑定期间读取运行时状态的唯一入口：持有 controller、限制单飞、卸载即取消。
 * 调用方只接收快照并把它投影到唯一状态机，不在这里解释状态。
 */
export function useSessionBindingPoll(options: {
  sessionId: string | null;
  enabled: boolean;
  onSnapshot: (snapshot: AgentRuntimeSnapshot) => void;
  /** 等待总期限到期时回调（只一次），用于收敛到可重试的失败态。 */
  onDeadline?: () => void;
  intervalMs?: number;
  /** 不传表示不限时；等待态应当传值，否则界面可能永久停在初始化中。 */
  deadlineMs?: number;
}): void {
  const { sessionId, enabled, onSnapshot, onDeadline, intervalMs = SESSION_BINDING_POLL_INTERVAL_MS, deadlineMs } = options;
  const onSnapshotRef = useRef(onSnapshot);
  const onDeadlineRef = useRef(onDeadline);
  onSnapshotRef.current = onSnapshot;
  onDeadlineRef.current = onDeadline;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const poller = createSerialPoller<AgentRuntimeSnapshot>({
      intervalMs,
      read: (signal) => fetchRuntimeState(sessionId, signal),
      onResult: (snapshot) => onSnapshotRef.current(snapshot),
      onError: () => {
        // 读失败保持等待态：下一轮继续，最终由绑定完成、失败事件或总期限收敛。
      },
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      onDeadline: () => onDeadlineRef.current?.(),
    });
    poller.start();
    return () => poller.stop();
  }, [enabled, deadlineMs, intervalMs, onDeadline, sessionId]);
}
