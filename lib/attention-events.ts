import type { ExtensionUiRequest } from "./types";
type AttentionToolEvent = {
  type: "tool_execution_start" | "tool_execution_end";
  toolName: string;
  toolCallId: string;
  args?: unknown;
};

type AttentionSourceEvent = AttentionToolEvent | ExtensionUiRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toAttentionSourceEvent(value: unknown): AttentionSourceEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "tool_execution_start" || value.type === "tool_execution_end") {
    if (typeof value.toolName !== "string") return null;
    if (typeof value.toolCallId !== "string") return null;
    return {
      type: value.type,
      toolName: value.toolName,
      toolCallId: value.toolCallId,
      args: value.args,
    };
  }
  if (value.type !== "extension_ui_request" || typeof value.id !== "string" || typeof value.method !== "string") return null;
  const interactiveMethods = new Set(["select", "confirm", "input", "editor", "custom"]);
  if (!interactiveMethods.has(value.method)) return null;
  if (value.method !== "custom" && typeof value.title !== "string") return null;
  if (value.method === "confirm" && typeof value.message !== "string") return null;
  if (value.method === "select" && (!Array.isArray(value.options) || value.options.some((option) => typeof option !== "string"))) return null;
  if (value.method === "custom" && (!Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string"))) return null;
  return value as AttentionSourceEvent;
}


export type AttentionEvent =
  | {
      type: "attention";
      kind: "ask";
      sessionId: string;
      requestId: string;
      args: unknown;
    }
  | {
      type: "attention";
      kind: "dialog";
      sessionId: string;
      requestId: string;
      title?: string;
      body?: string;
    }
  | {
      type: "attention";
      kind: "custom";
      sessionId: string;
      requestId: string;
    };

type AttentionEventListener = (event: AttentionEvent) => void;

declare global {
  var __piAttentionListeners: Set<AttentionEventListener> | undefined;
  var __piAttentionActiveAskCalls: Map<string, Set<string>> | undefined;
}

function getListeners(): Set<AttentionEventListener> {
  if (!globalThis.__piAttentionListeners) globalThis.__piAttentionListeners = new Set();
  return globalThis.__piAttentionListeners;
}

function getActiveAskCalls(): Map<string, Set<string>> {
  if (!globalThis.__piAttentionActiveAskCalls) globalThis.__piAttentionActiveAskCalls = new Map();
  return globalThis.__piAttentionActiveAskCalls;
}

/** 会话中止或销毁时清理未正常结束的 ask，避免影响后续普通交互。 */
export function clearAttentionSession(sessionId: string): void {
  getActiveAskCalls().delete(sessionId);
}

/** 订阅已经筛选、归一化的全局交互事件。 */
export function subscribeAttentionEvents(listener: AttentionEventListener): () => void {
  const listeners = getListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 从会话事件中提取需要用户关注的交互，普通运行事件不会进入全局总线。 */
export function publishAttentionEvent(sessionId: string, sourceEvent: unknown): void {
  const event = toAttentionSourceEvent(sourceEvent);
  if (!event) return;
  const activeAskCalls = getActiveAskCalls();
  const sessionAskCalls = activeAskCalls.get(sessionId);
  let attentionEvent: AttentionEvent | null = null;

  if (event.type === "tool_execution_start" && event.toolName === "ask_user_question") {
    const calls = sessionAskCalls ?? new Set<string>();
    calls.add(event.toolCallId);
    activeAskCalls.set(sessionId, calls);
    attentionEvent = {
      type: "attention",
      kind: "ask",
      sessionId,
      requestId: String(event.toolCallId),
      args: event.args,
    };
  } else if (event.type === "extension_ui_request") {
    const request = event as ExtensionUiRequest;
    // 上游 UI 协议不携带来源 toolCallId，只能在 ask 活跃期间按会话抑制 select/input。
    // 这是显式的启发式：避免 ask 重复通知，但可能同时抑制该会话内无关的 select/input。
    const shouldSuppressDialog = (sessionAskCalls?.size ?? 0) > 0
      && (request.method === "select" || request.method === "input");
    if (!shouldSuppressDialog && (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor")) {
      attentionEvent = {
        type: "attention",
        kind: "dialog",
        sessionId,
        requestId: request.id,
        title: request.title,
        body: request.method === "confirm" ? request.message : undefined,
      };
    } else if (request.method === "custom" && !request.closed) {
      attentionEvent = {
        type: "attention",
        kind: "custom",
        sessionId,
        requestId: request.id,
      };
    }
  }

  if (event.type === "tool_execution_end" && event.toolName === "ask_user_question") {
    sessionAskCalls?.delete(event.toolCallId);
    if (sessionAskCalls?.size === 0) activeAskCalls.delete(sessionId);
  }
  if (!attentionEvent) return;
  for (const listener of getListeners()) {
    try {
      listener(attentionEvent);
    } catch (error) {
      console.error("全局交互通知监听器执行失败", {
        sessionId,
        kind: attentionEvent.kind,
        requestId: attentionEvent.requestId,
        error,
      });
    }
  }
}
