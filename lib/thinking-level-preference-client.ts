import { isThinkingLevel, resolvePreferredThinkingLevel, type ThinkingLevel, type ThinkingLevelOption } from "./thinking-levels";

export async function fetchThinkingLevelRecommendation(
  modelId: string,
  signal?: AbortSignal,
): Promise<ThinkingLevel | null> {
  try {
    const response = await fetch(
      `/api/thinking-level-preferences?modelId=${encodeURIComponent(modelId)}`,
      signal ? { signal } : undefined,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinkingLevel?: unknown };
    return isThinkingLevel(data.thinkingLevel) ? data.thinkingLevel : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.error("[pi-web] 获取思考强度偏好失败:", error);
    return null;
  }
}

/**
 * 切到这个模型时该用的档位：`enabledModels` 的 `:level` pin → 最近用过的众数 → 当前档位，
 * 再限幅到该模型支持的列表（`supported` 未知时只做前两步）。
 * 返回 null 表示保持不动——没有 pin/众数，而且当前档位本来就受支持。
 */
export async function fetchPreferredThinkingLevel(args: {
  model: { provider: string; modelId: string };
  pins?: Record<string, ThinkingLevel> | null;
  supported?: readonly ThinkingLevel[] | null;
  current?: ThinkingLevelOption | null;
  signal?: AbortSignal;
}): Promise<ThinkingLevel | null> {
  const pin = args.pins?.[`${args.model.provider}/${args.model.modelId}`] ?? null;
  const recommendation = pin ? null : await fetchThinkingLevelRecommendation(args.model.modelId, args.signal);
  return resolvePreferredThinkingLevel({ pin, recommendation, supported: args.supported, current: args.current });
}

export async function recordThinkingLevelPreference(
  modelId: string,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  try {
    const response = await fetch("/api/thinking-level-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, thinkingLevel }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // 偏好记账失败不能影响已经成功提交的用户消息。
    console.error("[pi-web] 记录思考强度偏好失败:", error);
  }
}
