type RefreshTask = () => Promise<void> | void;

type RefreshState = {
  queued: boolean;
  running: boolean;
  dirty: boolean;
  task: RefreshTask;
};

/**
 * 按会话合并上下文刷新：同一事件批次只执行一次；执行期间的新事件在结束后补跑一次。
 * cancel 会同时使已排队和执行后的补跑失效，实际请求取消由调用方的请求门负责。
 */
export class SessionContextRefreshScheduler {
  private readonly states = new Map<string, RefreshState>();

  schedule(sessionId: string, task: RefreshTask): void {
    const current = this.states.get(sessionId);
    if (current) {
      current.task = task;
      current.dirty = true;
      if (!current.queued && !current.running) this.queue(sessionId, current);
      return;
    }

    const state: RefreshState = { queued: false, running: false, dirty: true, task };
    this.states.set(sessionId, state);
    this.queue(sessionId, state);
  }

  cancel(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private queue(sessionId: string, state: RefreshState): void {
    state.queued = true;
    queueMicrotask(() => void this.flush(sessionId, state));
  }

  private async flush(sessionId: string, state: RefreshState): Promise<void> {
    if (this.states.get(sessionId) !== state) return;
    state.queued = false;
    if (!state.dirty || state.running) return;

    state.dirty = false;
    state.running = true;
    try {
      await state.task();
    } finally {
      if (this.states.get(sessionId) !== state) return;
      state.running = false;
      if (state.dirty) this.queue(sessionId, state);
      else this.states.delete(sessionId);
    }
  }
}
