import defaultConfigJson from "./model-brand-icons.json";

export interface ModelBrandIconDefinition {
  /** public/provider-icons.svg 中的 symbol id。 */
  symbol?: string;
  /** 可选自定义图标地址（仅允许站内绝对路径 /... 或 https://...）。 */
  src?: string;
  /** 可选短文字徽标（最多 4 个字符），无图标资源时作为兜底。 */
  badge?: string;
  /** true 表示 SVG 自带品牌配色；false 则跟随 currentColor。 */
  color?: boolean;
  /** 厂商显示名，用于提示文本与归属标识。 */
  vendor?: string;
}

export interface ModelBrandIconRule {
  /** 正则表达式字符串。 */
  pattern: string;
  /** 正则标志，默认 "i"；只接受 i/u，避免 g/y 带来 lastIndex 状态副作用。 */
  flags?: string;
  /** 指向 icons 里的键名。 */
  icon: string;
  /** 覆盖该规则匹配结果的厂商显示名。 */
  vendor?: string;
}

export interface ModelBrandIconsConfig {
  version: number;
  icons: Record<string, ModelBrandIconDefinition>;
  /** 优先针对模型显示名与 modelId 匹配的规则（按顺序命中第一条）。 */
  modelRules: ModelBrandIconRule[];
  /** 未命中 modelRules 时，按 provider / 渠道名兜底匹配的规则。 */
  providerRules: ModelBrandIconRule[];
}

export interface ModelBrandLookupInput {
  provider?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  name?: string | null;
}

export interface ResolvedModelBrandIcon {
  id: string;
  symbol?: string;
  src?: string;
  badge?: string;
  color: boolean;
  vendor?: string;
}

interface CompiledRule {
  regex: RegExp;
  icon: string;
  vendor?: string;
}

export interface CompiledModelBrandIcons {
  icons: Record<string, ModelBrandIconDefinition>;
  modelRules: CompiledRule[];
  providerRules: CompiledRule[];
}

const MAX_PATTERN_LENGTH = 512;
const MAX_CUSTOM_RULES = 200;
const SYMBOL_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeFlags(flags: unknown): string {
  if (typeof flags !== "string") return "i";
  let result = "";
  if (flags.includes("i")) result += "i";
  if (flags.includes("u")) result += "u";
  return result;
}

function isSafeIconSrc(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  return trimmed.startsWith("https://");
}

function normalizeIconDefinition(raw: unknown): ModelBrandIconDefinition | null {
  if (!isRecord(raw)) return null;
  const symbol = typeof raw.symbol === "string" && SYMBOL_ID_RE.test(raw.symbol.trim())
    ? raw.symbol.trim()
    : undefined;
  const src = typeof raw.src === "string" && isSafeIconSrc(raw.src)
    ? raw.src.trim()
    : undefined;
  const badge = typeof raw.badge === "string" && raw.badge.trim()
    ? raw.badge.trim().slice(0, 4)
    : undefined;
  if (!symbol && !src && !badge) return null;
  const vendor = typeof raw.vendor === "string" && raw.vendor.trim()
    ? raw.vendor.trim()
    : undefined;
  return {
    ...(symbol ? { symbol } : {}),
    ...(src ? { src } : {}),
    ...(badge ? { badge } : {}),
    color: raw.color === true,
    ...(vendor ? { vendor } : {}),
  };
}

function normalizeRule(raw: unknown): ModelBrandIconRule | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.pattern !== "string" || typeof raw.icon !== "string") return null;
  const pattern = raw.pattern.trim();
  const icon = raw.icon.trim();
  if (!pattern || !icon || pattern.length > MAX_PATTERN_LENGTH) return null;
  const flags = sanitizeFlags(raw.flags);
  try {
    // 提前校验正则合法性，避免坏规则落入配置。
    new RegExp(pattern, flags);
  } catch {
    return null;
  }
  const vendor = typeof raw.vendor === "string" && raw.vendor.trim()
    ? raw.vendor.trim()
    : undefined;
  return {
    pattern,
    ...(flags !== "i" ? { flags } : {}),
    icon,
    ...(vendor ? { vendor } : {}),
  };
}

function normalizeRuleList(raw: unknown): ModelBrandIconRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ModelBrandIconRule[] = [];
  for (const item of raw) {
    if (rules.length >= MAX_CUSTOM_RULES) break;
    const rule = normalizeRule(item);
    if (rule) rules.push(rule);
  }
  return rules;
}

function normalizeIconMap(raw: unknown): Record<string, ModelBrandIconDefinition> {
  if (!isRecord(raw)) return {};
  const icons: Record<string, ModelBrandIconDefinition> = {};
  for (const [key, value] of Object.entries(raw)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    const def = normalizeIconDefinition(value);
    if (def) icons[cleanKey] = def;
  }
  return icons;
}

export function normalizeModelBrandIconsConfig(raw: unknown): ModelBrandIconsConfig | null {
  if (!isRecord(raw)) return null;
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1;
  return {
    version,
    icons: normalizeIconMap(raw.icons),
    modelRules: normalizeRuleList(raw.modelRules),
    providerRules: normalizeRuleList(raw.providerRules),
  };
}

/** 合并用户自定义配置：用户规则前置优先生效，同名 icon 定义由用户覆盖。 */
export function mergeModelBrandIconsConfig(
  base: ModelBrandIconsConfig,
  override: unknown,
): ModelBrandIconsConfig {
  const custom = normalizeModelBrandIconsConfig(override);
  if (!custom) return base;
  return {
    version: base.version,
    icons: { ...base.icons, ...custom.icons },
    modelRules: [...custom.modelRules, ...base.modelRules],
    providerRules: [...custom.providerRules, ...base.providerRules],
  };
}

export const DEFAULT_MODEL_BRAND_ICONS_CONFIG: ModelBrandIconsConfig =
  normalizeModelBrandIconsConfig(defaultConfigJson) ?? {
    version: 1,
    icons: {},
    modelRules: [],
    providerRules: [],
  };

function compileRules(rules: ModelBrandIconRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      compiled.push({
        regex: new RegExp(rule.pattern, sanitizeFlags(rule.flags)),
        icon: rule.icon,
        vendor: rule.vendor,
      });
    } catch {
      // 忽略无法编译的规则
    }
  }
  return compiled;
}

export function compileModelBrandIcons(config: ModelBrandIconsConfig): CompiledModelBrandIcons {
  return {
    icons: config.icons,
    modelRules: compileRules(config.modelRules),
    providerRules: compileRules(config.providerRules),
  };
}

export const DEFAULT_COMPILED_MODEL_BRAND_ICONS: CompiledModelBrandIcons =
  compileModelBrandIcons(DEFAULT_MODEL_BRAND_ICONS_CONFIG);

/**
 * 拆分形如 "Claude Fable 5.2 · anyrouter.top" 的模型展示名，
 * 避免中转渠道后缀干扰模型厂商判断。
 */
function splitDisplayModelName(value: string): { primary: string; channel?: string } {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("·");
  if (separatorIndex === -1) return { primary: trimmed };
  const primary = trimmed.slice(0, separatorIndex).trim();
  const channel = trimmed.slice(separatorIndex + 1).trim();
  return {
    primary: primary || trimmed,
    ...(channel ? { channel } : {}),
  };
}

function matchRules(
  candidates: readonly string[],
  rules: readonly CompiledRule[],
  icons: Record<string, ModelBrandIconDefinition>,
): ResolvedModelBrandIcon | null {
  // 外层按规则顺序遍历，确保高优先级规则（如用户自定义规则）先检查全部候选值。
  for (const rule of rules) {
    const def = icons[rule.icon];
    if (!def) continue;
    for (const candidate of candidates) {
      if (!candidate || !rule.regex.test(candidate)) continue;
      return {
        id: rule.icon,
        ...(def.symbol ? { symbol: def.symbol } : {}),
        ...(def.src ? { src: def.src } : {}),
        ...(def.badge ? { badge: def.badge } : {}),
        color: def.color === true,
        ...(rule.vendor ?? def.vendor ? { vendor: rule.vendor ?? def.vendor } : {}),
      };
    }
  }
  return null;
}

/**
 * 按 JSON 规则解析模型对应的品牌图标：
 * 1. 先按模型展示名 / modelId 匹配 modelRules；
 * 2. 未命中时再按 provider / providerName / 渠道后缀匹配 providerRules。
 */
export function resolveModelBrandIcon(
  input: ModelBrandLookupInput | null | undefined,
  compiled: CompiledModelBrandIcons = DEFAULT_COMPILED_MODEL_BRAND_ICONS,
): ResolvedModelBrandIcon | null {
  if (!input) return null;

  const modelCandidates: string[] = [];
  const channelFallbacks: string[] = [];

  if (typeof input.name === "string" && input.name.trim()) {
    const parts = splitDisplayModelName(input.name);
    modelCandidates.push(parts.primary);
    if (parts.channel) channelFallbacks.push(parts.channel);
  }
  if (typeof input.modelId === "string" && input.modelId.trim()) {
    const parts = splitDisplayModelName(input.modelId);
    if (!modelCandidates.includes(parts.primary)) modelCandidates.push(parts.primary);
    if (parts.channel && !channelFallbacks.includes(parts.channel)) channelFallbacks.push(parts.channel);
  }

  const fromModel = matchRules(modelCandidates, compiled.modelRules, compiled.icons);
  if (fromModel) return fromModel;

  const providerCandidates: string[] = [];
  for (const value of [input.provider, input.providerName, ...channelFallbacks]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && !providerCandidates.includes(trimmed)) providerCandidates.push(trimmed);
  }

  return matchRules(providerCandidates, compiled.providerRules, compiled.icons);
}
