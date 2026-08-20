import { LatestRequestGate } from "./latest-request-gate";

export type LatestContextResult<T> =
  | { committed: true; value: T }
  | { committed: false };

/**
 * 管理按会话互斥的异步上下文加载。
 * 新任务会取消同一会话的旧任务，并在 finally 中统一释放请求和 generation。
 */
export class LatestContextLoader {
  private readonly gate = new LatestRequestGate();
  private readonly controllers = new Map<string, AbortController>();

  async run<T, R>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    commit: (value: T) => R,
    ...syncGuard: R extends PromiseLike<unknown> ? ["commit 回调必须同步"] : []
  ): Promise<LatestContextResult<R>> {
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const generation = this.gate.begin(key);

    try {
      const value = await task(controller.signal);
      if (controller.signal.aborted || !this.gate.isLatest(key, generation)) return { committed: false };
      // commit 不得异步；最新性检查与状态提交必须处于同一个同步执行段。
      return { committed: true, value: commit(value) };
    } catch (error) {
      if (controller.signal.aborted || !this.gate.isLatest(key, generation)) return { committed: false };
      throw error;
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      this.gate.finish(key);
    }
  }

  cancel(key: string): void {
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.gate.invalidate(key);
  }

  /** 诊断当前未释放的会话请求数量，不参与业务控制流。 */
  get activeCount(): number {
    return this.controllers.size;
  }
}
