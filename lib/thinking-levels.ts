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

/**
 * 把档位落进模型支持的列表：规则与 pi 的 `clampThinkingLevel` 一致——先往上找（更高的档位），
 * 再往下找，都没有就用第一个支持的档位。`supported` 未知（null/空）时原样返回。
 */
export function clampThinkingLevelToSupported(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[] | null | undefined,
): ThinkingLevel {
  if (!supported || supported.length === 0 || supported.includes(level)) return level;
  const requested = THINKING_LEVELS.indexOf(level);
  if (requested === -1) return supported[0];
  for (let index = requested; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0];
}

export interface PreferredThinkingLevelArgs {
  /** `enabledModels` 的 `:level` 后缀（`provider/modelId` 键），优先级最高。 */
  pin?: ThinkingLevel | null;
  /** 这个模型最近用过的众数（`lib/thinking-level-preferences.ts`）。 */
  recommendation?: ThinkingLevel | null;
  /** 新模型支持的档位；未知时不限幅。 */
  supported?: readonly ThinkingLevel[] | null;
  /** 兜底：当前档位。`auto` 表示用户没显式选过，不算兜底值。 */
  current?: ThinkingLevelOption | null;
}

/**
 * 切换模型时该用的档位：pin → 最近用过的众数 → 当前档位，再限幅到新模型支持的列表。
 * 只有什么都不知道时才返回 null（当前档位是 `auto` 且没有 pin/众数）。
 */
export function resolvePreferredThinkingLevel(args: PreferredThinkingLevelArgs): ThinkingLevel | null {
  const picked = args.pin ?? args.recommendation ?? (isThinkingLevel(args.current) ? args.current : null);
  return picked ? clampThinkingLevelToSupported(picked, args.supported) : null;
}

/**
 * 新会话界面显示的档位：内部 `auto` 时显示 settings 的默认档位，但要按当前模型限幅——
 * 否则默认档位是 `max`、模型最高只到 `high` 时，选择器会显示一个这个模型做不到的档位。
 */
export function resolveDisplayedThinkingLevel(args: {
  level: ThinkingLevelOption;
  fallback?: ThinkingLevelOption | null;
  supported?: readonly ThinkingLevel[] | null;
}): ThinkingLevelOption {
  if (args.level !== "auto") return args.level;
  if (!args.fallback) return "auto";
  return isThinkingLevel(args.fallback) ? clampThinkingLevelToSupported(args.fallback, args.supported) : args.fallback;
}
