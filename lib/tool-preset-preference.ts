import { CONFIGURED_TOOL_PRESET, SETTINGS_BUILTIN_TOOLS, isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Only an explicit pick from the tool dropdown is ever stored, so a missing value
 * means "never chose". Those users fall back to the configured preset rather than
 * silently pinning pi-web's four built-ins over settings.json defaultTools (#700).
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return CONFIGURED_TOOL_PRESET;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : CONFIGURED_TOOL_PRESET;
  } catch {
    return CONFIGURED_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}

const CUSTOM_TOOLS_STORAGE_KEY = "pi-web:custom-tools";

export function getPreferredCustomTools(): string[] | null {
  try {
    const stored: unknown = JSON.parse(getBrowserStorage()?.getItem(CUSTOM_TOOLS_STORAGE_KEY) ?? "null");
    if (!Array.isArray(stored) || stored.length === 0 || stored.some((tool) => !SETTINGS_BUILTIN_TOOLS.includes(tool))) return null;
    return [...new Set(stored as string[])];
  } catch {
    return null;
  }
}

export function setPreferredCustomTools(tools: readonly string[] | null): void {
  try {
    getBrowserStorage()?.setItem(CUSTOM_TOOLS_STORAGE_KEY, JSON.stringify(tools));
  } catch (error) {
    console.warn("[pi-web] 无法保存自定义工具选择", error);
  }
}
