import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL_BRAND_ICONS_CONFIG,
  mergeModelBrandIconsConfig,
  type ModelBrandIconsConfig,
} from "./model-brand-icon";

export const USER_MODEL_ICONS_FILENAME = "pi-web-model-icons.json";

interface CachedConfig {
  path: string;
  mtimeMs: number;
  size: number;
  config: ModelBrandIconsConfig;
}

declare global {
  var __piWebModelBrandIconsCache: CachedConfig | undefined;
}

export function getUserModelBrandIconsPath(agentDir = getAgentDir()): string {
  return join(agentDir, USER_MODEL_ICONS_FILENAME);
}

/**
 * 读取内置规则并与可选的 `<agentDir>/pi-web-model-icons.json` 合并。
 * 用户文件不存在或损坏时安全回退到内置规则，不阻塞页面加载。
 */
export function loadModelBrandIconsConfig(agentDir = getAgentDir()): ModelBrandIconsConfig {
  const userPath = getUserModelBrandIconsPath(agentDir);
  let stats: { mtimeMs: number; size: number };
  try {
    const fileStat = statSync(userPath);
    if (!fileStat.isFile()) return DEFAULT_MODEL_BRAND_ICONS_CONFIG;
    stats = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch {
    if (globalThis.__piWebModelBrandIconsCache?.path === userPath) {
      globalThis.__piWebModelBrandIconsCache = undefined;
    }
    return DEFAULT_MODEL_BRAND_ICONS_CONFIG;
  }

  const cached = globalThis.__piWebModelBrandIconsCache;
  if (cached && cached.path === userPath && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.config;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(userPath, "utf8"));
    const merged = mergeModelBrandIconsConfig(DEFAULT_MODEL_BRAND_ICONS_CONFIG, parsed);
    globalThis.__piWebModelBrandIconsCache = {
      path: userPath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      config: merged,
    };
    return merged;
  } catch (error) {
    console.warn(`[pi-web] Failed to load ${userPath}; falling back to built-in model icon rules:`, error);
    return DEFAULT_MODEL_BRAND_ICONS_CONFIG;
  }
}

export function resetModelBrandIconsCacheForTests(): void {
  globalThis.__piWebModelBrandIconsCache = undefined;
}
