import { isSessionTitleOperationEvent } from "./session-title-events";

interface SessionTitleEventSource {
  onmessage: EventSource["onmessage"];
  onerror: EventSource["onerror"];
  close(): void;
}

export interface RunSessionTitleOperationOptions {
  sessionId: string;
  operationId: string;
  createEventSource?: (url: string) => SessionTitleEventSource;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** 执行一次手动标题操作，统一管理 SSE 协议、POST、总截止时间和资源释放。 */
export async function runSessionTitleOperation({
  sessionId,
  operationId,
  createEventSource = (url) => new EventSource(url),
  fetchFn = fetch,
  timeoutMs = 110_000,
}: RunSessionTitleOperationOptions): Promise<string> {
  const eventSource = createEventSource(`/api/agent/${encodeURIComponent(sessionId)}/events`);
  const abortController = new AbortController();
  let resolveConnected: (() => void) | undefined;
  let rejectConnected: ((error: Error) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  let terminalSettled = false;

  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const completion = new Promise<string>((resolve, reject) => {
    rejectCompletion = reject;
    eventSource.onmessage = (message) => {
      try {
        const event: unknown = JSON.parse(message.data);
        if (event && typeof event === "object" && (event as { type?: string }).type === "connected") {
          resolveConnected?.();
          return;
        }
        if (!isSessionTitleOperationEvent(event, sessionId, operationId)) return;
        terminalSettled = true;
        if (event.type === "session_title_updated") resolve(event.title);
        else reject(new Error(event.error));
      } catch {
        // 忽略非 JSON 或不符合标题操作契约的 SSE 消息。
      }
    };
  });
  // POST 或连接阶段可能先失败，提前消费终态拒绝，避免未处理 Promise。
  void completion.catch(() => {});

  eventSource.onerror = () => {
    if (terminalSettled) return;
    const error = new Error("Session title event stream disconnected");
    abortController.abort(error);
    rejectConnected?.(error);
    rejectCompletion?.(error);
  };

  const submitRequest = async (): Promise<void> => {
    const response = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId }),
      signal: abortController.signal,
    });
    const body = await response.json().catch(() => ({})) as { error?: string; operationId?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (body.operationId !== operationId) throw new Error("Session title operation id mismatch");
  };
  const workflow = async (): Promise<string> => {
    await connected;
    // POST 与 SSE 终态并行：终态先到后，后续 SSE error 不会推翻已完成的 completion。
    const [, title] = await Promise.all([submitRequest(), completion]);
    return title.trim();
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = new Error("Session title operation timed out");
      abortController.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    // deadline 即使遇到忽略 AbortSignal 的 fetch 也能强制退出。
    return await Promise.race([workflow(), deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    abortController.abort();
    eventSource.close();
  }
}
