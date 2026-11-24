import type { ThinkingLevel } from "./thinking-levels";

type ModelIdentity = { provider: string; modelId: string };

/** 推荐档只属于提供推荐的模型；手动档和旧客户端不带归属，沿用原来的启动规则。 */
export function resolveStartupThinkingRecommendation(
  level: ThinkingLevel | undefined,
  owner: ModelIdentity | undefined,
  actual: { provider: string; id: string } | undefined,
): ThinkingLevel | undefined {
  if (!owner) return level;
  return actual?.provider === owner.provider && actual.id === owner.modelId ? level : undefined;
}
