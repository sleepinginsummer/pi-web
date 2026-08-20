import type { ModelLike } from "./pi-types";
import { createFastSessionModel, isFastModeAvailable } from "./fast-mode";

export const FAST_SESSION_STATE = "pi-web-fast-mode-state";

export type FastStateEntryLike = { type: string; customType?: string; data?: unknown };

export type FastSessionSettingHost = {
  entries: () => readonly FastStateEntryLike[];
  currentModel: () => ModelLike | undefined;
  catalogModel: (provider: string, modelId: string) => ModelLike | undefined;
  setModel: (model: ModelLike) => Promise<void>;
  appendState: (enabled: boolean) => void;
};

export function readSessionFastEnabled(entries: readonly FastStateEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== FAST_SESSION_STATE) continue;
    const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled === "boolean") return enabled;
  }
  return false;
}

/** 串行协调 Fast 偏好、模型切换和 runtime 恢复，确保最后一次操作生效。 */
export class FastSessionSetting {
  private desired: boolean;
  private applied = false;
  private revision = 0;
  private persistedRevision = 0;
  private targetModel: { provider: string; modelId: string } | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: FastSessionSettingHost) {
    this.desired = readSessionFastEnabled(host.entries());
  }

  get current(): boolean { return this.desired; }
  get available(): boolean { return isFastModeAvailable(this.resolveBaseModel()); }

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (enabled && !this.available) throw new Error("Fast 模式仅支持具备 Priority 能力的 OpenAI-compatible provider");
    this.desired = enabled;
    const requestRevision = ++this.revision;
    try {
      await this.enqueue();
      return this.desired;
    } catch (error) {
      if (this.revision === requestRevision) this.desired = this.applied;
      throw error;
    }
  }

  async selectModel(baseModel: ModelLike): Promise<void> {
    this.targetModel = { provider: baseModel.provider, modelId: baseModel.id };
    await this.enqueue();
  }

  async restoreAfterRuntimeReset(): Promise<void> {
    const current = this.host.currentModel();
    this.targetModel = current
      ? { provider: current.provider, modelId: current.id }
      : undefined;
    this.applied = false;
    if (this.desired) await this.enqueue();
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(() => this.reconcile());
    return this.queue;
  }

  private async reconcile(): Promise<void> {
    const baseModel = this.resolveBaseModel();
    if (!baseModel) return;
    const effective = this.desired && isFastModeAvailable(baseModel);
    await this.host.setModel(createFastSessionModel(baseModel, effective));
    this.applied = this.desired;
    if (this.persistedRevision < this.revision) {
      const revision = this.revision;
      this.host.appendState(this.desired);
      this.persistedRevision = revision;
    }
  }

  private resolveBaseModel(): ModelLike | undefined {
    if (this.targetModel) {
      return this.host.catalogModel(this.targetModel.provider, this.targetModel.modelId);
    }
    const current = this.host.currentModel();
    return current ? this.host.catalogModel(current.provider, current.id) : undefined;
  }
}
