export type NewSessionModel = { provider: string; modelId: string };

type NewSessionMaterializationBase = {
  sessionId: string;
  model?: NewSessionModel | null;
  thinkingLevel?: unknown;
  shadowMindEnabled: boolean;
  shadowMindAvailable: boolean;
};

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
  if (candidate.kind === "ready") return candidate.success === true && "data" in candidate;
  return candidate.kind === "initialization-failed"
    && candidate.success === false
    && typeof candidate.error === "string";
}
