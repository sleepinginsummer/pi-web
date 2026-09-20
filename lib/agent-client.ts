// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { MAX_CLIENT_REQUEST_BODY_BYTES } from "./request-limits";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

function createRequestId(): string {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const isSubmitCommand = command.type === "prompt"
    || command.type === "steer"
    || command.type === "follow_up";
  // 提交类命令携带调用方认定的会话身份，服务端据此拒绝路由与运行时不一致的请求。
  const requestCommand = isSubmitCommand
    ? {
        ...command,
        clientSessionId: sessionId,
        requestId: createRequestId(),
      }
    : command;
  const requestBody = JSON.stringify(requestCommand);
  // Proxy 限制针对序列化后的整个请求体；发送前拒绝才能可靠恢复文本和图片草稿。
  if (new TextEncoder().encode(requestBody).byteLength > MAX_CLIENT_REQUEST_BODY_BYTES) {
    const isPrompt = command.type === "prompt";
    throw new AgentCommandError(
      `消息和附件总大小超过 ${MAX_CLIENT_REQUEST_BODY_BYTES / (1024 * 1024)}MB 限制`,
      413,
      isPrompt ? "prompt_rejected" : "request_too_large",
      false,
    );
  }
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
