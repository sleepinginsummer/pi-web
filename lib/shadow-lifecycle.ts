import type { SessionEntry } from "./types";

export type ShadowLifecycleSnapshot = {
  changed: boolean;
  hasActiveRuns: boolean;
};

type ShadowLifecyclePayload = {
  kind?: unknown;
  data?: { runId?: unknown };
};

/**
 * 维护当前页面已观察到的 Shadow 生命周期。
 * entry id 用于抵御 SSE 重连产生的重复投递；终态 run id 用于避免乱序 start 重新激活已结束任务。
 */
export class ShadowLifecycleCoordinator {
  private readonly activeRunIds = new Set<string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly consumedEntryIds = new Set<string>();

  get hasActiveRuns(): boolean {
    return this.activeRunIds.size > 0;
  }

  consume(entry: SessionEntry | undefined): ShadowLifecycleSnapshot {
    if (entry?.type !== "custom" || entry.customType !== "shadow-mind-event") {
      return this.snapshot(false);
    }
    if (this.consumedEntryIds.has(entry.id)) return this.snapshot(false);

    const payload = entry.data as ShadowLifecyclePayload | undefined;
    if (payload?.kind !== "run-start" && payload?.kind !== "run-end" && payload?.kind !== "runs-aborted") {
      return this.snapshot(false);
    }

    this.consumedEntryIds.add(entry.id);
    const runId = typeof payload.data?.runId === "string" ? payload.data.runId : undefined;
    if (payload.kind === "run-start" && runId && !this.terminalRunIds.has(runId)) {
      this.activeRunIds.add(runId);
    } else if (payload.kind === "run-end" && runId) {
      this.terminalRunIds.add(runId);
      this.activeRunIds.delete(runId);
    } else if (payload.kind === "runs-aborted") {
      for (const activeRunId of this.activeRunIds) this.terminalRunIds.add(activeRunId);
      this.activeRunIds.clear();
    }

    return this.snapshot(true);
  }

  reset(): void {
    this.activeRunIds.clear();
    this.terminalRunIds.clear();
    this.consumedEntryIds.clear();
  }

  private snapshot(changed: boolean): ShadowLifecycleSnapshot {
    return { changed, hasActiveRuns: this.hasActiveRuns };
  }
}
