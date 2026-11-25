"use client";

import { useEffect, useRef, useState } from "react";
import { formatToolDuration, formatToolStartedAt, validToolTime } from "@/lib/tool-timing";
import { toolClockMs, type ToolClock } from "@/lib/tool-clock";

/** 所有工具共用的时间行；计时更新只重绘这个小组件，不重绘输出正文。 */
export function ToolTiming({ startedAt, durationMs, elapsedMs, running, clock }: {
  startedAt?: number;
  durationMs?: number;
  elapsedMs?: number;
  running: boolean;
  clock?: ToolClock;
}) {
  const [firstSeen] = useState(() => ({ wall: Date.now(), monotonic: performance.now() }));
  const [now, setNow] = useState(() => ({ wall: Date.now(), monotonic: performance.now() }));
  // 子调用快照携带服务端已运行时长；用本地单调时钟接着走，不比较两台设备的时钟。
  const [snapshotAnchor, setSnapshotAnchor] = useState(() => ({ monotonic: performance.now(), elapsed: validToolTime(elapsedMs) }));
  useEffect(() => {
    setSnapshotAnchor({ monotonic: performance.now(), elapsed: validToolTime(elapsedMs) });
  }, [elapsedMs]);
  const live = running && (clock ? "startedAt" in clock : durationMs === undefined);
  const wasLive = useRef(live);
  const [stoppedAt, setStoppedAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (live) { wasLive.current = true; setStoppedAt(undefined); }
    else if (wasLive.current) setStoppedAt(performance.now());
  }, [live]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow({ wall: Date.now(), monotonic: performance.now() }), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const start = validToolTime(clock?.wallStartedAt) ?? validToolTime(startedAt) ?? (wasLive.current ? firstSeen.wall : undefined);
  const elapsed = !live && durationMs !== undefined ? durationMs
    : live && snapshotAnchor.elapsed !== undefined ? snapshotAnchor.elapsed + Math.max(0, now.monotonic - snapshotAnchor.monotonic)
    : clock ? toolClockMs(clock, live ? now.monotonic : stoppedAt ?? now.monotonic)
    : wasLive.current ? Math.max(0, (stoppedAt ?? now.monotonic) - firstSeen.monotonic + firstSeen.wall - (start ?? firstSeen.wall))
    : durationMs;
  return (
    <span data-tool-timing="" style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, marginLeft: "auto", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      <time dateTime={start === undefined ? undefined : new Date(start).toISOString()}>{formatToolStartedAt(start)}</time>
      {" · "}{elapsed === undefined ? "—" : formatToolDuration(elapsed)}
    </span>
  );
}
