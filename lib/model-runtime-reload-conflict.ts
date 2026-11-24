export const MODEL_RUNTIME_RELOAD_CONFLICT_CODE = "model_runtime_reload_conflict";

/** 临时运行时冲突；启动选模可等重载结束后重试，显式选模则交给调用方重试。 */
export class ModelRuntimeReloadConflictError extends Error {
  readonly code = MODEL_RUNTIME_RELOAD_CONFLICT_CODE;
  readonly retryable = true;

  constructor() {
    super("模型配置已重载，请重试选择模型");
    this.name = "ModelRuntimeReloadConflictError";
  }
}

/** 使用稳定标记识别，避免热更新前后的 Error 构造函数身份不同。 */
export function isModelRuntimeReloadConflict(error: unknown): error is ModelRuntimeReloadConflictError {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === MODEL_RUNTIME_RELOAD_CONFLICT_CODE
    && "retryable" in error && error.retryable === true;
}
