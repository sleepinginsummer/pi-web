const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionTitleOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_RE.test(value);
}

export type SessionTitleOperationEvent =
  | {
      type: "session_title_updated";
      sessionId: string;
      operationId: string;
      title: string;
    }
  | {
      type: "session_title_error";
      sessionId: string;
      operationId: string;
      error: string;
    };

/** 只接收当前会话、当前手动标题操作的完整终态事件。 */
export function isSessionTitleOperationEvent(
  event: unknown,
  sessionId: string,
  operationId: string,
): event is SessionTitleOperationEvent {
  if (!event || typeof event !== "object") return false;
  const candidate = event as Record<string, unknown>;
  if (candidate.sessionId !== sessionId || candidate.operationId !== operationId) return false;
  if (candidate.type === "session_title_updated") return typeof candidate.title === "string";
  if (candidate.type === "session_title_error") return typeof candidate.error === "string";
  return false;
}
