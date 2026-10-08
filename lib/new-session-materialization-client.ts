"use client";

import {
  isNewSessionMaterializationResult,
  isNewSessionRuntimeCreated,
  type NewSessionMaterializationResult,
  type NewSessionRuntimeCreated,
  type NewSessionModel,
} from "./new-session-protocol";

type NewSessionMaterializationConfig = {
  cwd: string;
  toolNames?: string[];
  shadowMindEnabled: boolean;
  model?: NewSessionModel;
  thinkingLevel?: unknown;
  fastEnabled?: boolean;
};

export type NewSessionMaterializationRequest = NewSessionMaterializationConfig & (
  | { operation: "create" }
  | { operation: "finalize-existing"; sessionId: string }
);

const materializations = new Map<string, Promise<NewSessionMaterializationResult | NewSessionRuntimeCreated>>();

function materializationKey(request: NewSessionMaterializationRequest): string {
  return request.operation === "create"
    ? `create:${request.cwd}`
    : `finalize:${request.cwd}:${request.sessionId}`;
}

async function requestNewSessionMaterialization(
  request: NewSessionMaterializationRequest,
): Promise<NewSessionMaterializationResult | NewSessionRuntimeCreated> {
  const response = await fetch("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: request.cwd,
      operation: request.operation,
      ...(request.operation === "finalize-existing" ? { sessionId: request.sessionId } : {}),
      type: "ensure_session",
      ...(request.toolNames !== undefined ? { toolNames: request.toolNames } : {}),
      ...(!request.shadowMindEnabled ? { shadowMindEnabled: false } : {}),
      ...(request.model ? { provider: request.model.provider, modelId: request.model.modelId } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.fastEnabled ? { fastEnabled: true } : {}),
    }),
  });
  const payload: unknown = await response.json();
  if (!isNewSessionMaterializationResult(payload) && !isNewSessionRuntimeCreated(payload)) {
    throw new Error(`新会话创建接口返回无效数据（HTTP ${response.status}）`);
  }
  return payload;
}

/** 未发送会话按 cwd 复用同一个纯创建请求；调用方在 await 后自行接管 runtime。 */
function requestOnce(
  request: NewSessionMaterializationRequest,
): Promise<NewSessionMaterializationResult | NewSessionRuntimeCreated> {
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

/** 每个挂载方都先接管同一个 runtime 并连接 SSE，再复用第二阶段请求。 */
export async function materializeNewSession(
  request: NewSessionMaterializationRequest,
  onRuntimeCreated: (sessionId: string) => Promise<void>,
): Promise<NewSessionMaterializationResult> {
  let sessionId = request.operation === "finalize-existing" ? request.sessionId : undefined;
  try {
    if (request.operation === "create") {
      const created = await requestOnce(request);
      if (created.kind !== "runtime-created") return created;
      sessionId = created.sessionId;
    }
    await onRuntimeCreated(sessionId!);
    const result = await requestOnce({ ...request, operation: "finalize-existing", sessionId: sessionId! });
    if (result.kind === "runtime-created") throw new Error("初始化接口返回了未完成的 runtime");
    return result;
  } catch (error) {
    // 创建成功后的事件流/初始化故障必须保留身份，重试只能 finalize，不能再创建。
    if (!sessionId) throw error;
    return {
      kind: "materialization-failed",
      success: false,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** AppShell 已提交 terminal control 后释放该 cwd 的共享结果。 */
export function releaseNewSessionMaterialization(cwd: string): void {
  materializations.delete(`create:${cwd}`);
  for (const key of materializations.keys()) {
    if (key.startsWith(`finalize:${cwd}:`)) materializations.delete(key);
  }
}
export type { NewSessionMaterializationResult } from "./new-session-protocol";
