export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Active, but left out of requests: the model calls it only from codemode scripts. */
  declarationHidden?: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

/** Presets that pin an explicit tool list onto the session. */
export const CONCRETE_TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ConcreteToolPreset = typeof CONCRETE_TOOL_PRESET_VALUES[number];

/**
 * "configured" is not a tool list: it means "send no override", so pi resolves the
 * loadout from settings.json defaultTools exactly like the `pi` CLI does. Sessions
 * left on it stay unpinned and keep following the setting as it changes.
 */
export const CONFIGURED_TOOL_PRESET = "configured";
export const TOOL_PRESET_VALUES = ["configured", "none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];
/** The built-in tools Settings › General switches in the global defaultTools; `bash` is the active shell. */
export const SETTINGS_BUILTIN_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "edit", "write", "bash"];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function isConcreteToolPreset(value: unknown): value is ConcreteToolPreset {
  return typeof value === "string" && (CONCRETE_TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ConcreteToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  if (toolNames.length === 0) return "none";

  const active = toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

/** Undefined means "no explicit selection": let pi resolve settings.json defaultTools. */
export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === CONFIGURED_TOOL_PRESET) return undefined;
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

/**
 * 预设的界面名字（i18n key）。菜单行和输入框上的 chip 共用这一套，
 * 否则会出现一半用英文标识符（full/configured）、一半用译名（自定义）的混搭。
 */
export function toolPresetLabelKey(preset: ToolPreset): string {
  if (preset === "none") return "chat.presetOff";
  if (preset === CONFIGURED_TOOL_PRESET) return "chat.presetConfigured";
  if (preset === "read-only") return "chat.presetReadOnly";
  if (preset === "full") return "chat.presetFull";
  return "chat.presetDefault";
}

/**
 * 设置里启用（settings.json `defaultTools`）、但这个会话拿不到的内置工具。
 *
 * `expected` 是会话要的那份：有钉死名单就用名单，跟随 settings.json 时就是设置本身。
 * 只有"要了却没激活"的名字才算进来 —— 被预设主动排除的（例如 read-only 里的 bash/edit）
 * 不在 `expected` 里，不会被误标。差出来的通常是扩展用自己的工具接替了它
 * （`pi-hashline-edit-pro` 把 edit 换成 replace/insert 一族）。任一输入未知时返回空，
 * 不猜。
 */
export function missingBuiltinTools(
  settingsTools: readonly string[] | null | undefined,
  expectedTools: readonly string[] | null | undefined,
  liveTools: readonly string[] | null | undefined,
): string[] {
  if (!settingsTools || !expectedTools || !liveTools) return [];
  return expectedTools.filter((name) => settingsTools.includes(name) && !liveTools.includes(name));
}
