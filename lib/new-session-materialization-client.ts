"use client";

import {
  isNewSessionMaterializationResult,
  type NewSessionMaterializationResult,
  type NewSessionModel,
} from "./new-session-protocol";

type NewSessionMaterializationConfig = {
  cwd: string;
  toolNames: string[];
  shadowMindEnabled: boolean;
  model?: NewSessionModel;
  thinkingLevel?: unknown;
  fastEnabled?: boolean;
};

export type NewSessionMaterializationRequest = NewSessionMaterializationConfig & (
  | { operation: "create" }
  | { operation: "finalize-existing"; sessionId: string }
);

const materializations = new Map<string, Promise<NewSessionMaterializationResult>>();

function materializationKey(request: NewSessionMaterializationRequest): string {
  return request.operation === "create"
    ? `create:${request.cwd}`
    : `finalize:${request.cwd}:${request.sessionId}`;
}

async function requestNewSessionMaterialization(
  request: NewSessionMaterializationRequest,
): Promise<NewSessionMaterializationResult> {
  const response = await fetch("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: request.cwd,
      operation: request.operation,
      ...(request.operation === "finalize-existing" ? { sessionId: request.sessionId } : {}),
      type: "ensure_session",
      toolNames: request.toolNames,
      ...(!request.shadowMindEnabled ? { shadowMindEnabled: false } : {}),
      ...(request.model ? { provider: request.model.provider, modelId: request.model.modelId } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.fastEnabled ? { fastEnabled: true } : {}),
    }),
  });
  const payload: unknown = await response.json();
  if (!isNewSessionMaterializationResult(payload)) {
    throw new Error(`新会话创建接口返回无效数据（HTTP ${response.status}）`);
  }
  return payload;
}

/** 未发送会话按 cwd 复用同一个纯创建请求；调用方在 await 后自行接管 runtime。 */
export function materializeNewSession(
  request: NewSessionMaterializationRequest,
): Promise<NewSessionMaterializationResult> {
  const key = materializationKey(request);
  const existing = materializations.get(key);
  if (existing) return existing;

  const promise = requestNewSessionMaterialization(request);
  materializations.set(key, promise);
  void promise.catch(() => {
    if (materializations.get(key) === promise) materializations.delete(key);
  });
  return promise;
}

/** AppShell 已提交 terminal control 后释放该 cwd 的共享结果。 */
export function releaseNewSessionMaterialization(cwd: string): void {
  materializations.delete(`create:${cwd}`);
  for (const key of materializations.keys()) {
    if (key.startsWith(`finalize:${cwd}:`)) materializations.delete(key);
  }
}
export type { NewSessionMaterializationResult } from "./new-session-protocol";
