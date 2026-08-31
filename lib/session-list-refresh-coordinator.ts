export type SessionListRefreshRequest = {
  reason: "new-session-persisted" | "run-settled" | "title-generated";
  sessionId: string;
};

export type SessionListRefreshScheduler = {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

export const NEW_SESSION_SETTLED_REFRESH_DELAY_MS = 5_000;
export const MAX_TRACKED_SESSION_REFRESHES = 256;

function touchBoundedSet(values: Set<string>, value: string): void {
  values.delete(value);
  values.add(value);
  while (values.size > MAX_TRACKED_SESSION_REFRESHES) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

/** 合并新会话首次落盘、settled 与迟到标题触发的完整列表刷新。 */
export class SessionListRefreshCoordinator {
  private readonly persistedNewSessions = new Set<string>();
  private readonly titledSessions = new Set<string>();
  private readonly pendingSettled = new Map<string, unknown>();

  constructor(
    private readonly refresh: () => void,
    private readonly scheduler: SessionListRefreshScheduler,
  ) {}

  request(request: SessionListRefreshRequest): void {
    const { reason, sessionId } = request;
    if (reason === "new-session-persisted") {
      if (this.persistedNewSessions.has(sessionId) || this.titledSessions.has(sessionId)) return;
      touchBoundedSet(this.persistedNewSessions, sessionId);
      this.refresh();
      return;
    }

    if (reason === "title-generated") {
      if (this.titledSessions.has(sessionId)) {
        touchBoundedSet(this.titledSessions, sessionId);
        return;
      }
      touchBoundedSet(this.titledSessions, sessionId);
      const settledWasPending = this.cancelPending(sessionId);
      if (settledWasPending) this.persistedNewSessions.delete(sessionId);
      this.refresh();
      return;
    }

    // settleRun 已在 ChatWindow 当前挂载内去重；局部 runId 不能跨 remount 持久化。
    if (!this.persistedNewSessions.has(sessionId)) {
      this.refresh();
      return;
    }
    if (this.titledSessions.has(sessionId)) {
      this.persistedNewSessions.delete(sessionId);
      return;
    }
    if (this.pendingSettled.has(sessionId)) return;

    const handle = this.scheduler.set(() => {
      this.pendingSettled.delete(sessionId);
      this.persistedNewSessions.delete(sessionId);
      this.refresh();
    }, NEW_SESSION_SETTLED_REFRESH_DELAY_MS);
    this.pendingSettled.set(sessionId, handle);
  }

  dispose(): void {
    for (const handle of this.pendingSettled.values()) this.scheduler.clear(handle);
    this.pendingSettled.clear();
    this.persistedNewSessions.clear();
    this.titledSessions.clear();
  }

  private cancelPending(sessionId: string): boolean {
    const handle = this.pendingSettled.get(sessionId);
    if (handle === undefined) return false;
    this.scheduler.clear(handle);
    this.pendingSettled.delete(sessionId);
    return true;
  }
}
