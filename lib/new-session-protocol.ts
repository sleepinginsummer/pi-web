export type NewSessionModel = { provider: string; modelId: string };

export type NewSessionRuntimeCreated = { kind: "runtime-created"; success: true; sessionId: string };

type NewSessionMaterializationBase = {
  sessionId: string;
  model?: NewSessionModel | null;
  thinkingLevel?: unknown;
  /** runtime 已就绪但扩展 session_start 仍在进行：可以显示会话，发送要等它结束。 */
  extensionsInitializing?: boolean;
  extensionsError?: string | null;
  shadowMindEnabled: boolean;
  shadowMindAvailable: boolean;
};

/** 扩展绑定状态是协议字段，任何入口都只能通过这个投影解释，禁止各自判断布尔值。 */
export type ExtensionBindingState = "bound" | "binding" | "failed";

export type ExtensionBindingSnapshot = {
  extensionsInitializing?: boolean;
  extensionsError?: string | null;
};

/**
 * 失败优先，其次初始化中，最后才算已完成：
 * 服务端绑定失败时返回的是 extensionsInitializing: false 加上错误文本，
 * 只看布尔值会把失败当成已就绪并提前解锁发送。
 */
export function projectExtensionBinding(source: ExtensionBindingSnapshot): ExtensionBindingState {
  if (typeof source.extensionsError === "string" && source.extensionsError !== "") return "failed";
  if (source.extensionsInitializing) return "binding";
  return "bound";
}

export type NewSessionMaterializationResult =
  | (NewSessionMaterializationBase & { kind: "ready"; success: true; data: unknown })
  | (NewSessionMaterializationBase & { kind: "initialization-failed"; success: false; error: string })
  | { kind: "materialization-failed"; success: false; sessionId: string; error: string };

function isNewSessionModel(value: unknown): value is NewSessionModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model.provider === "string" && typeof model.modelId === "string";
}

/** 严格校验 `/api/agent/new` 的可判别返回，禁止接管字段不完整的 runtime。 */
export function isNewSessionMaterializationResult(value: unknown): value is NewSessionMaterializationResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "materialization-failed") {
    return candidate.success === false
      && typeof candidate.sessionId === "string"
      && typeof candidate.error === "string";
  }
  if (
    typeof candidate.sessionId !== "string"
    || typeof candidate.shadowMindEnabled !== "boolean"
    || typeof candidate.shadowMindAvailable !== "boolean"
  ) return false;
  if (candidate.model !== undefined && candidate.model !== null && !isNewSessionModel(candidate.model)) return false;
  if (candidate.extensionsInitializing !== undefined && typeof candidate.extensionsInitializing !== "boolean") return false;
  if (candidate.extensionsError !== undefined && candidate.extensionsError !== null && typeof candidate.extensionsError !== "string") return false;
  if (candidate.kind === "ready") return candidate.success === true && "data" in candidate;
  return candidate.kind === "initialization-failed"
    && candidate.success === false
    && typeof candidate.error === "string";
}

/** 第一阶段只确认 runtime 身份，不把未完成的扩展初始化误报为 ready。 */
export function isNewSessionRuntimeCreated(value: unknown): value is NewSessionRuntimeCreated {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "runtime-created"
    && candidate.success === true
    && typeof candidate.sessionId === "string"
    && candidate.sessionId.length > 0;
}
