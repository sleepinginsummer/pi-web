/** 工具卡片的实时计时：开始时间使用墙上时钟，耗时使用本地单调时钟；供客户端使用。 */

/** startedAt 是页面的单调时钟坐标，wallStartedAt 是显示用的实际开始时刻。 */
export type ToolClock = ({ startedAt: number } | { durationMs: number }) & { wallStartedAt?: number };

export type ToolClocks = ReadonlyMap<string, ToolClock>;

export const NO_TOOL_CLOCKS: ToolClocks = new Map();

interface ToolExecutionEventLike {
  type: string;
  toolCallId?: unknown;
  parentToolCallId?: unknown;
  elapsedMs?: unknown;
  durationMs?: unknown;
  startedAt?: unknown;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 参数出现或工具开始时建立时钟，重放用 elapsedMs 还原；重复开始不重置。
 * 结束保留服务端展示耗时；嵌套调用由父 codemode 的快照独立计时。
 */
export function applyToolClockEvent(clocks: ToolClocks, event: ToolExecutionEventLike, now: number): ToolClocks {
  const id = event.toolCallId;
  if (typeof id !== "string" || (typeof event.parentToolCallId === "string" && event.parentToolCallId !== "")) return clocks;
  if (event.type === "tool_execution_start") {
    if (clocks.has(id)) return clocks;
    const next = new Map(clocks);
    next.set(id, { startedAt: now - (nonNegative(event.elapsedMs) ?? 0),
      wallStartedAt: nonNegative(event.startedAt) ?? Date.now() - (nonNegative(event.elapsedMs) ?? 0) });
    return next;
  }
  if (event.type === "tool_execution_end") {
    const durationMs = nonNegative(event.durationMs);
    if (durationMs === undefined) return withoutToolClock(clocks, id);
    const next = new Map(clocks);
    next.set(id, { durationMs, wallStartedAt: nonNegative(event.startedAt) ?? clocks.get(id)?.wallStartedAt });
    return next;
  }
  return clocks;
}

/** The clocks without a call's: its result message has arrived. */
export function withoutToolClock(clocks: ToolClocks, id: string): ToolClocks {
  if (!clocks.has(id)) return clocks;
  const next = new Map(clocks);
  next.delete(id);
  return next;
}

/**
 * The clocks a reconnect keeps: ended calls' measured times. The server replays only calls still
 * running, and an ended call of a parallel batch waits for its siblings before its result arrives.
 */
export function endedToolClocks(clocks: ToolClocks): ToolClocks {
  const next = new Map([...clocks].filter(([, clock]) => "durationMs" in clock));
  return next.size === clocks.size ? clocks : next.size ? next : NO_TOOL_CLOCKS;
}

/** A clock's time at `now`: the run so far, or pi's measured time. */
export function toolClockMs(clock: ToolClock, now: number): number {
  return "durationMs" in clock ? clock.durationMs : Math.max(0, now - clock.startedAt);
}

/** 参数刚开始流入时卡片已经可见，不能等真正 execute 才建立时钟。 */
export function applyToolAppearanceEvent(clocks: ToolClocks, event: { type: string; id?: string; startedAt?: number; elapsedMs?: number }, now: number): ToolClocks {
  if (!event.type.startsWith("toolcall_") || !event.id) return clocks;
  return applyToolClockEvent(clocks, { type: "tool_execution_start", toolCallId: event.id, startedAt: event.startedAt, elapsedMs: event.elapsedMs }, now);
}

/** 权威运行态已空闲时冻结遗漏结束事件的计时器，避免停止后仍继续增长。 */
export function settleToolClocks(clocks: ToolClocks, now: number): ToolClocks {
  let next: Map<string, ToolClock> | undefined;
  for (const [id, clock] of clocks) {
    if (!("startedAt" in clock)) continue;
    next ??= new Map(clocks);
    next.set(id, { durationMs: toolClockMs(clock, now), wallStartedAt: clock.wallStartedAt });
  }
  return next ?? clocks;
}
