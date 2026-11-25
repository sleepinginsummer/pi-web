import {
  compileModelBrandIcons,
  DEFAULT_COMPILED_MODEL_BRAND_ICONS,
  normalizeModelBrandIconsConfig,
  type CompiledModelBrandIcons,
} from "./model-brand-icon";

export interface BrandIconStoreSnapshot {
  compiled: CompiledModelBrandIcons;
  namesVersion: number;
}

let currentSnapshot: BrandIconStoreSnapshot = {
  compiled: DEFAULT_COMPILED_MODEL_BRAND_ICONS,
  namesVersion: 0,
};
export const SERVER_BRAND_ICON_SNAPSHOT: BrandIconStoreSnapshot = currentSnapshot;
const modelDisplayNames = new Map<string, string>();
let loadStarted = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeModelBrandIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getModelBrandIconsSnapshot(): BrandIconStoreSnapshot {
  return currentSnapshot;
}

/**
 * 登记 /api/models 返回的 `provider:modelId -> 展示名` 映射，
 * 让只有 provider/modelId 的会话行也能按展示名识别品牌图标并给出可读提示。
 */
export function registerModelDisplayNames(names: Record<string, string> | null | undefined): void {
  if (!names) return;
  let changed = false;
  for (const [key, value] of Object.entries(names)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (modelDisplayNames.get(key) !== value) {
      modelDisplayNames.set(key, value);
      changed = true;
    }
  }
  if (!changed) return;
  currentSnapshot = {
    compiled: currentSnapshot.compiled,
    namesVersion: currentSnapshot.namesVersion + 1,
  };
  emitChange();
}

export function lookupModelDisplayName(
  provider?: string | null,
  modelId?: string | null,
): string | undefined {
  if (!provider || !modelId) return undefined;
  return modelDisplayNames.get(`${provider}:${modelId}`);
}

export function ensureUserModelBrandIconsLoaded(): void {
  if (loadStarted || typeof window === "undefined" || typeof fetch !== "function") return;
  loadStarted = true;
  void fetch("/api/model-icons", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      const raw: unknown = await response.json();
      const normalized = normalizeModelBrandIconsConfig(raw);
      if (!normalized) return;
      currentSnapshot = {
        compiled: compileModelBrandIcons(normalized),
        namesVersion: currentSnapshot.namesVersion,
      };
      emitChange();
    })
    .catch(() => {
      // 拉取失败时保持内置默认规则，不干扰界面显示
    });
}
