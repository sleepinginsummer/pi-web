"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 轮询一个只读 JSON 接口（标签页可见时才发请求）。
 *
 * 底栏三处轮询（开发服务、定时任务、后台命令）共用这一份：
 *
 * - **引用稳定**：内容没变时把上一个对象原样返回。以前每 4~6 秒 `setData(新对象)`，
 *   下游组件即使一行都没变也会重渲染。
 * - **不重复请求**：回到前台与定时器撞在一起时共用同一次 in-flight 请求。
 * - **旧响应不覆盖新状态**：每次请求带序号，慢响应晚到时丢弃。
 */
export function usePolledJson<T extends object>(url: string | null, intervalMs: number | (() => number)) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  // 当前接口地址：换项目会换 URL，旧请求（含操作后的那次 refresh）回来时必须认得出。
  const urlRef = useRef(url);
  urlRef.current = url;
  // 间隔可以按当前状态算（有服务正在启动/命令还在跑时快一些）：放进 ref 读最新值，
  // 免得每次改快慢都重启轮询、连带多发一次请求。
  const delayRef = useRef(intervalMs);
  delayRef.current = intervalMs;
  const nextDelay = useCallback(() => {
    const value = delayRef.current;
    return typeof value === "function" ? value() : value;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    // 已经换了项目/接口：旧项目那次操作收尾时发起的刷新直接丢掉，不发请求也不写数据。
    if (!url || urlRef.current !== url) return;
    const requestedUrl = url;
    const request = ++requestRef.current;
    const isCurrent = () => request === requestRef.current && urlRef.current === requestedUrl;
    try {
      const response = await fetch(requestedUrl, { cache: "no-store" });
      const next = await response.json() as T & { error?: string };
      if (!isCurrent()) return;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setData((current) => (sameJson(current, next) ? current : next));
      setError(null);
    } catch (cause) {
      // 请求序号和当前 URL 都要对得上：序号挡同一接口的乱序，URL 挡换项目后的旧结果。
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [url]);

  useEffect(() => {
    setData(null);
    setError(null);
    // 换接口后，旧请求的结果已经没有意义。
    requestRef.current += 1;
  }, [url]);

  useEffect(() => {
    if (!url) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let inFlight: Promise<void> | null = null;
    const load = (): Promise<void> => {
      // 回前台与定时器可能同时到点：等这一次的结果，不再多发一个请求。
      if (inFlight) return inFlight;
      inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await load();
      if (!stopped) timer = setTimeout(tick, nextDelay());
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nextDelay, refresh, url]);

  return { data, error, refresh, setData, setError };
}

/** 结构与内容都没变时让调用方继续用旧对象：轮询拿到的多是重复快照。 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // 循环结构之类没法比较的内容，保守当作有变化。
    return false;
  }
}
