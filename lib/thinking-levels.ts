import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type { ThinkingLevel };

/** SDK 接受的实际思考等级；auto 不是运行等级。 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

// SDK 扩展 ThinkingLevel union 时强制此处同步，避免合法等级在 UI/API 中缺失。
type MissingThinkingLevel = Exclude<ThinkingLevel, (typeof THINKING_LEVELS)[number]>;
const allThinkingLevelsCovered: MissingThinkingLevel extends never ? true : never = true;
void allThinkingLevelsCovered;

/** auto 仅表示前端不显式覆盖，让 Pi 按模型 pin 或默认配置解析。 */
export type ThinkingLevelOption = "auto" | ThinkingLevel;

export const THINKING_LEVEL_OPTIONS = [
  "auto",
  ...THINKING_LEVELS,
] as const satisfies readonly ThinkingLevelOption[];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string"
    && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isThinkingLevelOption(value: unknown): value is ThinkingLevelOption {
  return value === "auto" || isThinkingLevel(value);
}

export function parseThinkingLevelOption(
  value: unknown,
  fallback: ThinkingLevelOption = "auto",
): ThinkingLevelOption {
  return isThinkingLevelOption(value) ? value : fallback;
}
