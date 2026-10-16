export interface RunCompletionValue {
  runId: number;
  sessionId: string | null;
  /** 运行被停止（任一客户端的 Stop/Esc）而非完成：不播放提示音、不发通知。 */
  aborted: boolean;
}

/** 维护单个主运行的采用与完成边界，不保留无界历史。 */
export class RunCompletionController {
  private currentRunId: number | null = null;
  private lastCompletedRunId: number | null = null;

  beginRun(runId: number): void {
    this.currentRunId = runId;
  }

  settleRun(runId: number, sessionId: string | null, aborted = false): RunCompletionValue | null {
    if (this.currentRunId !== runId || this.lastCompletedRunId === runId) return null;
    this.lastCompletedRunId = runId;
    this.currentRunId = null;
    return { runId, sessionId, aborted };
  }
}
