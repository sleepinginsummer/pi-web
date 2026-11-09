"use client";

import { commitStagedSystemPromptAddon } from "./system-prompt-addon-client";

import {
  isNewSessionMaterializationResult,
  isNewSessionRuntimeCreated,
  type NewSessionMaterializationResult,
  type NewSessionRuntimeCreated,
  type NewSessionModel,
} from "./new-session-protocol";

/** 创建/初始化请求的上限：静默排队（例如浏览器连接被占满）不能变成永久等待。 */
const NEW_SESSION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 每个 cwd 的一次创建意图对应一个稳定 operationId。
 * 请求超时只代表"结果未知"：服务端可能已经建好 runtime，
 * 因此重试必须复用同一个 id，让服务端交回同一个 runtime 而不是再建一个孤儿会话。
 */
const creationOperations = new Map<string, string>();

function creationOperationId(cwd: string): string {
  const existing = creationOperations.get(cwd);
  if (existing) return existing;
  const created = globalThis.crypto?.randomUUID?.() ?? `new-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  creationOperations.set(cwd, created);
  return created;
}

/** 仅供测试隔离模块级创建意图。 */
export function resetCreationOperationsForTests(): void {
  creationOperations.clear();
}

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
  // 请求带上限：静默排队（例如浏览器连接被占满）不能变成永久等待。
  let response: Response;
  try {
    response = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(NEW_SESSION_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        cwd: request.cwd,
        operation: request.operation,
        ...(request.operation === "finalize-existing" ? { sessionId: request.sessionId } : {}),
        ...(request.operation === "create" ? { operationId: creationOperationId(request.cwd) } : {}),
        type: "ensure_session",
        ...(request.toolNames !== undefined ? { toolNames: request.toolNames } : {}),
        ...(request.shadowMindEnabled ? { shadowMindEnabled: true } : {}),
        ...(request.model ? { provider: request.model.provider, modelId: request.model.modelId } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        ...(request.fastEnabled ? { fastEnabled: true } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`新会话请求超过 ${NEW_SESSION_REQUEST_TIMEOUT_MS / 1000}s 未响应，请重试`);
    }
    throw error;
  }
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

/** 只创建 runtime 并交付身份；与其他挂载方共用同一个创建请求。 */
export async function createNewSessionRuntime(config: NewSessionMaterializationConfig): Promise<string> {
  const created = await requestOnce({ ...config, operation: "create" });
  if (created.kind === "runtime-created" || created.success) {
    await commitStagedSystemPromptAddon(config.cwd, created.sessionId);
    return created.sessionId;
  }
  throw new Error(created.error);
}

/**
 * 把首条消息交给服务端。服务端按 runtime 去重，所以网络失败时重试一次不会重复发送。
 * 这个请求不依赖调用它的组件，切换页面后照常完成。
 */
export async function submitNewSessionFirstPrompt(request: Pick<NewSessionMaterializationConfig, "cwd" | "shadowMindEnabled"> & {
  sessionId: string;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}): Promise<void> {
  const submit = async () => {
    const response = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(NEW_SESSION_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        cwd: request.cwd,
        operation: "submit-first-prompt",
        type: "submit_first_prompt",
        sessionId: request.sessionId,
        message: request.message,
        ...(request.images?.length ? { images: request.images } : {}),
        ...(request.shadowMindEnabled ? { shadowMindEnabled: true } : {}),
      }),
    });
    const payload = await response.json() as { kind?: unknown; error?: unknown };
    if (payload.kind === "first-prompt-accepted") return;
    // 服务端明确拒绝不必重试。
    throw Object.assign(new Error(typeof payload.error === "string" ? payload.error : `首条消息提交失败（HTTP ${response.status}）`), { rejected: true });
  };
  try {
    await submit();
  } catch (error) {
    if ((error as { rejected?: boolean }).rejected) throw error;
    await submit();
  }
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
  // 终态（会话已接管或显式放弃）后才允许下一次创建意图使用新的 operationId。
  creationOperations.delete(cwd);
  for (const key of materializations.keys()) {
    if (key.startsWith(`finalize:${cwd}:`)) materializations.delete(key);
  }
}
export type { NewSessionMaterializationResult } from "./new-session-protocol";
