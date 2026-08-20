import type { ModelLike } from "./pi-types";
import { isFastModeProviderAllowed } from "./fast-mode-capabilities";

/** Fast 同时要求协议兼容和 provider 明确授权。 */
export function isFastModeAvailable(model: ModelLike | undefined): boolean {
  if (!model || !isFastModeProviderAllowed(model.provider)) return false;
  return model.api === "openai-responses" || model.api === "openai-completions";
}

/** 基于目录模型创建会话私有副本，禁止请求档位污染共享模型目录。 */
export function createFastSessionModel(baseModel: ModelLike, fastEnabled: boolean): ModelLike {
  const samplingParams = baseModel.samplingParams ? { ...baseModel.samplingParams } : undefined;
  return {
    ...baseModel,
    compat: baseModel.compat ? { ...baseModel.compat } : undefined,
    samplingParams: fastEnabled && isFastModeAvailable(baseModel)
      ? { ...samplingParams, service_tier: "priority" }
      : samplingParams,
  };
}
