import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * SDK setModel 在 await checkAuth 后同步改模型并追加记录，没有独立的 before-write 钩子。
 * 对本次操作临时包装会话自有 runtime 的鉴权入口，在成功鉴权返回前检查写入边界；
 * 操作结束即恢复原方法。调用方须持有模型偏好队列、不能并行包装同一 runtime，并在 operation 中同步调用 SDK setModel；
 * 所有成功鉴权都检查可写性；只有首个、本次选模的鉴权触发版本检查和回滚捕获。
 */
export async function withModelAuthWriteGuard<T>(
  runtime: Pick<ModelRuntime, "checkAuth">,
  assertWritable: () => void,
  operation: () => Promise<T>,
  beforeOwnedWrite?: () => void,
): Promise<T> {
  const original = runtime.checkAuth;
  let firstAuth = true;
  const guarded: ModelRuntime["checkAuth"] = async (providerId, options) => {
    // SDK setModel 同步发起的首次鉴权属于本次操作；扩展并发鉴权不能替本次操作捕获回滚状态。
    const owned = firstAuth;
    firstAuth = false;
    const auth = await original.call(runtime, providerId, options);
    if (auth) {
      assertWritable();
      if (owned) beforeOwnedWrite?.();
    }
    return auth;
  };
  runtime.checkAuth = guarded;
  try {
    return await operation();
  } finally {
    // 期间若 runtime 被替换/重新装配，不把新的入口写回旧方法。
    if (runtime.checkAuth === guarded) runtime.checkAuth = original;
  }
}
