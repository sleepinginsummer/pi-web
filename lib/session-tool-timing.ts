import { validToolTime, type ToolTimingInfo } from "./tool-timing";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
interface Clock extends ToolTimingInfo { monotonicStart: number; calls?: Clock[]; persisted?: boolean }

/** 只在展示副本与保存副本上补计时，不修改 SDK 或扩展持有的消息、details。 */
export class SessionToolTimings {
  private tools = new Map<string, Clock>();
  private shells: Array<Clock & { command: string }> = [];
  constructor(private wallNow = () => Date.now(), private monotonicNow = () => performance.now()) {}

  private start(): Clock { return { startedAt: this.wallNow(), monotonicStart: this.monotonicNow() }; }
  private ensure(id: string): Clock {
    let clock = this.tools.get(id);
    if (!clock) { clock = this.start(); this.tools.set(id, clock); }
    return clock;
  }
  private finish(clock: Clock): void { clock.durationMs ??= Math.max(0, this.monotonicNow() - clock.monotonicStart); }
  private info(clock: Clock): ToolTimingInfo {
    return { startedAt: clock.startedAt, ...(clock.durationMs === undefined ? {} : { durationMs: clock.durationMs }) };
  }
  private calls(clock: Clock, details: unknown): unknown {
    if (!object(details) || !Array.isArray(details.calls)) return details;
    clock.calls ??= [];
    const calls = details.calls.map((call, index) => {
      if (!object(call)) return call;
      const previous = clock.calls![index];
      const child = clock.calls![index] ??= this.start();
      const ended = call.status !== "running" || clock.durationMs !== undefined;
      if (ended) {
        child.durationMs ??= previous
          ? Math.max(0, this.monotonicNow() - child.monotonicStart)
          : validToolTime(call.durationMs);
        if (!previous && child.durationMs !== undefined) child.startedAt -= child.durationMs;
      }
      return { ...call, startedAt: child.startedAt,
        ...(ended ? {} : { elapsedMs: Math.max(0, this.monotonicNow() - child.monotonicStart) }),
        ...(child.durationMs === undefined ? {} : { durationMs: child.durationMs }),
        ...(call.status === "running" && ended ? { status: "cancelled" } : {}) };
    });
    return { ...details, calls };
  }

  observe<T extends RecordValue>(event: T): T {
    const type = event.type;
    if (type === "message_update" && object(event.assistantMessageEvent)) {
      const delta = event.assistantMessageEvent;
      if (typeof delta.type === "string" && delta.type.startsWith("toolcall_")) {
        const partial = object(delta.partial) && Array.isArray(delta.partial.content) ? delta.partial.content : [];
        const block = object(delta.toolCall) ? delta.toolCall : partial[Number(delta.contentIndex)];
        const id = object(block) ? block.id ?? block.toolCallId : delta.id;
        if (typeof id === "string" && id) {
          const clock = this.ensure(id);
          return { ...event, assistantMessageEvent: { ...delta, startedAt: clock.startedAt, elapsedMs: Math.max(0, this.monotonicNow() - clock.monotonicStart),
            ...(object(delta.toolCall) ? { toolCall: { ...delta.toolCall, startedAt: clock.startedAt } } : {}) } };
        }
      }
    }
    // 嵌套执行事件由父 codemode 的有序快照计时，避免把不落盘的子事件留在主调用索引里。
    if (typeof event.parentToolCallId === "string" && event.parentToolCallId) return event;
    if (type === "agent_start") this.tools.clear();
    if (typeof event.toolCallId === "string") {
      const id = event.toolCallId;
      if (type === "tool_execution_start") {
        const clock = this.ensure(id);
        return { ...event, startedAt: clock.startedAt, elapsedMs: Math.max(0, this.monotonicNow() - clock.monotonicStart) };
      }
      if (type === "tool_execution_update" && event.toolName === "codemode" && object(event.partialResult)) {
        const clock = this.ensure(id);
        return { ...event, partialResult: { ...event.partialResult, details: this.calls(clock, event.partialResult.details) } };
      }
      if (type === "tool_execution_end") {
        const clock = this.ensure(id);
        this.finish(clock);
        if (event.toolName === "codemode" && object(event.result)) this.calls(clock, event.result.details);
        return { ...event, startedAt: clock.startedAt, durationMs: clock.durationMs };
      }
    }
    if ((type === "message_end" || type === "message_start") && object(event.message)) {
      return { ...event, message: this.message(event.message) };
    }
    return event;
  }

  message<T>(message: T, persisted = false): T {
    if (!object(message)) return message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.map((block) => {
        if (!object(block) || block.type !== "toolCall") return block;
        const id = block.id ?? block.toolCallId;
        if (typeof id !== "string") return block;
        return { ...block, startedAt: this.ensure(id).startedAt };
      });
      return { ...message, content };
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const clock = this.tools.get(message.toolCallId);
      if (!clock) return message;
      this.finish(clock);
      const details = message.toolName === "codemode" ? this.calls(clock, message.details) : message.details;
      const result = { ...message, details, toolTiming: this.info(clock) };
      if (persisted) {
        clock.persisted = true;
        // 完成项只留少量供紧随保存的广播复用，运行中的项绝不淘汰。
        for (const [id, old] of this.tools) {
          if (this.tools.size <= 256) break;
          if (old.persisted) this.tools.delete(id);
        }
      }
      return result;
    }
    if (message.role === "bashExecution") {
      const clock = this.shells.find((shell) => !shell.persisted && shell.command === message.command);
      if (!clock) return message;
      this.finish(clock);
      if (persisted) { clock.persisted = true; this.shells = this.shells.filter((shell) => shell !== clock); }
      return { ...message, toolTiming: this.info(clock) };
    }
    return message;
  }

  beginShell(command: string): Clock {
    const clock = { ...this.start(), command };
    this.shells.push(clock);
    return clock;
  }
  finishShell(clock: Clock): ToolTimingInfo { this.finish(clock); return this.info(clock); }
  discardShell(clock: Clock): void { this.shells = this.shells.filter((shell) => shell !== clock); }
}

// Next 的路由模块与 HMR 会重载模块；以 manager 为弱键保留其同一份计时，不保留会话本身。
const timingGlobal = globalThis as typeof globalThis & { __piWebSessionToolTimings?: WeakMap<object, SessionToolTimings> };
const trackers = timingGlobal.__piWebSessionToolTimings ??= new WeakMap<object, SessionToolTimings>();
export function installSessionToolTimings(manager: object): SessionToolTimings {
  const tracker = new SessionToolTimings();
  trackers.set(manager, tracker);
  return tracker;
}
export function sessionToolTimings(manager: object): SessionToolTimings | undefined { return trackers.get(manager); }
