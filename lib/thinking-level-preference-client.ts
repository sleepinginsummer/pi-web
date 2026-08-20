import { isThinkingLevel, type ThinkingLevel } from "./thinking-levels";

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
