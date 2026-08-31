import type { ModelLike } from "./pi-types";

export function getFastModelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Runtime 未物化时回退 catalog；明确的 true/false 始终由 runtime 接管。 */
export function resolveFastModeAvailability(
  runtimeAvailable: boolean | null,
  catalogAvailable: boolean,
): boolean {
  return runtimeAvailable ?? catalogAvailable;
}

/** Fast 要求协议兼容，并由官方 provider 或模型级配置明确声明 Priority 能力。 */
export function isFastModeAvailable(
  model: ModelLike | undefined,
  configuredModels: ReadonlySet<string>,
): boolean {
  if (!model) return false;
  const protocolCompatible = model.api === "openai-responses" || model.api === "openai-completions";
  if (!protocolCompatible) return false;
  return model.provider === "openai" || configuredModels.has(getFastModelKey(model.provider, model.id));
}

/** 基于目录模型创建会话私有副本，禁止请求档位污染共享模型目录。 */
export function createFastSessionModel(baseModel: ModelLike, fastEnabled: boolean): ModelLike {
  const samplingParams = baseModel.samplingParams ? { ...baseModel.samplingParams } : undefined;
  return {
    ...baseModel,
    compat: baseModel.compat ? { ...baseModel.compat } : undefined,
    samplingParams: fastEnabled
      ? { ...samplingParams, service_tier: "priority" }
      : samplingParams,
  };
}
