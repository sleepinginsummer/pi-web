import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModelsConfigPath } from "./models-config-store";
import { invalidateModelsCache } from "./models-cache";

const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 15_000;

interface RefreshableModelRuntime {
  refresh(options: {
    allowNetwork: boolean;
    force: boolean;
    providers: readonly string[];
    signal: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
}

interface ModelCatalogRefreshDependencies {
  createRuntime?: () => Promise<RefreshableModelRuntime>;
  createSignal?: () => AbortSignal;
}

/**
 * 绕过 SDK 的四小时远程目录新鲜度窗口，刷新本次模型配置涉及的 provider。
 * models.json 与远程目录是两份独立数据；刷新完成后还需清除 pi-web 的模型投影缓存。
 */
export async function forceRefreshModelCatalog(
  providerIds: readonly string[],
  dependencies: ModelCatalogRefreshDependencies = {},
): Promise<void> {
  const providers = [...new Set(providerIds.map((id) => id.trim()).filter(Boolean))];
  if (providers.length === 0) {
    invalidateModelsCache();
    return;
  }

  const runtime = await (dependencies.createRuntime ?? (() => ModelRuntime.create({
    modelsPath: getModelsConfigPath(),
    refreshOnCreate: false,
  })))();
  const signal = (dependencies.createSignal ?? (() => AbortSignal.timeout(MODEL_CATALOG_REFRESH_TIMEOUT_MS)))();
  const result = await runtime.refresh({
    allowNetwork: true,
    force: true,
    providers,
    signal,
  });

  if (result.aborted) throw new Error("模型目录强制刷新超时");
  if (result.errors.size > 0) {
    throw new AggregateError([...result.errors.values()], "模型目录强制刷新失败");
  }
  invalidateModelsCache();
}
