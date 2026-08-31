import type { ModelsData } from "./model-types";

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
  cwdGenerations: Map<string, number>;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

// 模型配置/Auth/项目信任变化都有主动失效；较长 TTL 避免新会话反复构建完整 Pi services。
const MODELS_CACHE_TTL_MS = 10 * 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
      cwdGenerations: new Map(),
    };
  }
  globalThis.__piModelsCacheState.cwdGenerations ??= new Map();
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(cwd?: string): void {
  const state = getModelsCacheState();
  if (cwd) {
    state.cwdGenerations.set(cwd, (state.cwdGenerations.get(cwd) ?? 0) + 1);
    state.entries.delete(cwd);
    state.inFlight.delete(cwd);
    return;
  }
  state.generation += 1;
  state.cwdGenerations.clear();
  state.entries.clear();
  state.inFlight.clear();
}

/** 默认模型变化不影响可用模型目录，直接更新已缓存投影，避免重建完整 services。 */
export function updateCachedDefaultModel(
  cwd: string,
  defaultModel: ModelsData["defaultModel"],
): void {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (!cached) return;
  state.entries.set(cwd, {
    ...cached,
    data: { ...cached.data, defaultModel },
  });
}
export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  const cwdGeneration = state.cwdGenerations.get(cwd) ?? 0;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (
        state.generation === generation
        && (state.cwdGenerations.get(cwd) ?? 0) === cwdGeneration
        && state.inFlight.get(cwd) === loadPromise
      ) {
        const now = Date.now();
        for (const [key, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(key);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
