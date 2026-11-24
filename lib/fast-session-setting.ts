import type { ModelLike } from "./pi-types";
import { createFastSessionModel, isFastModeAvailable } from "./fast-mode";
import { ModelRuntimeReloadConflictError } from "./model-runtime-reload-conflict";

export const FAST_SESSION_STATE = "pi-web-fast-mode-state";

export type FastStateEntryLike = { type: string; customType?: string; data?: unknown };

export interface FastRuntimeSnapshot {
  generation: string;
  catalogModel: (provider: string, modelId: string) => ModelLike | undefined;
  fastModels: ReadonlySet<string>;
}

type FastModelTarget = Pick<ModelLike, "provider" | "id">;

export type FastModelSelectionOptions = {
  /** 同身份重选必须仍由调用方判定时的模型拥有，不能在出队后升级为实际切模。 */
  expectedModel?: ModelLike;
  afterSameModelCommit?: () => void;
};

type FastModelSelection = FastModelSelectionOptions & { targetModel: FastModelTarget };

export type PreparedFastModel = {
  /** await 返回后、任何状态写入之前同步复核，之后到 commit 之间不得再 await。 */
  validate: () => void;
  commit: () => void;
};

export type FastSessionSettingHost = {
  entries: () => readonly FastStateEntryLike[];
  currentModel: () => ModelLike | undefined;
  runtimeSnapshot: () => FastRuntimeSnapshot;
  isReloading?: () => boolean;
  /** SDK 路径须在本次鉴权成功后、修改内存或历史之前同步调用 beforeWrite。 */
  setModel: (model: ModelLike, beforeWrite: () => void) => Promise<void>;
  /** 捕获内存回滚动作；不得调用会追加会话记录的 SDK setter。 */
  captureRuntime?: () => () => void;
  /** 同身份模型只改传输参数：鉴权后提供同步校验/提交动作，状态落盘前不得修改内存/档位。 */
  prepareSameModel?: (model: ModelLike) => Promise<PreparedFastModel>;
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
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: FastSessionSettingHost) {
    this.desired = readSessionFastEnabled(host.entries());
  }

  get current(): boolean { return this.desired; }
  get available(): boolean {
    const runtime = this.host.runtimeSnapshot();
    return isFastModeAvailable(this.resolveBaseModel(runtime), runtime.fastModels);
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    const runtime = this.host.runtimeSnapshot();
    if (enabled && !isFastModeAvailable(this.resolveBaseModel(runtime), runtime.fastModels)) {
      throw new Error("Fast 模式仅支持具备 Priority 能力的 OpenAI-compatible provider");
    }
    this.desired = enabled;
    const requestRevision = ++this.revision;
    try {
      await this.enqueue(runtime);
      return this.desired;
    } catch (error) {
      if (this.revision === requestRevision) this.desired = this.applied;
      throw error;
    }
  }

  /** 同身份配置重选的附加写入须同步完成，与模型替换共用提交前的回滚快照。 */
  async selectModel(baseModel: ModelLike, options: FastModelSelectionOptions = {}): Promise<void> {
    // 显式目标及预期引用仅属于本次任务，失败后不能影响 Fast 开关或可用性判断。
    await this.enqueue(undefined, { ...options, targetModel: { provider: baseModel.provider, id: baseModel.id } });
  }

  async restoreAfterRuntimeReset(): Promise<void> {
    this.applied = false;
    if (this.desired) await this.enqueue();
  }

  private enqueue(runtime = this.host.runtimeSnapshot(), selection?: FastModelSelection): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(() => this.reconcile(runtime, selection));
    return this.queue;
  }

  /** 无变化重选也要遵守同一条重载边界，不能直接报告成功。 */
  assertSelectionReady(): void {
    if (this.host.isReloading?.()) throw new ModelRuntimeReloadConflictError();
  }

  private assertSelectionRuntimeCurrent(runtime: FastRuntimeSnapshot, selection?: FastModelSelection): void {
    if (selection && (this.host.isReloading?.() || this.host.runtimeSnapshot().generation !== runtime.generation)) {
      throw new ModelRuntimeReloadConflictError();
    }
  }

  private async reconcile(runtime: FastRuntimeSnapshot, selection?: FastModelSelection): Promise<void> {
    this.assertSelectionRuntimeCurrent(runtime, selection);
    // 普通 Fast 恢复任务继续让位于新 runtime，显式选模已在上面拒绝失效任务。
    if (this.host.runtimeSnapshot().generation !== runtime.generation) return;
    // 在任何鉴权、SDK 选模或写入之前确认重选仍属于原模型；比较引用而非 provider/id。
    if (selection?.expectedModel && this.host.currentModel() !== selection.expectedModel) {
      throw new Error("重选等待期间模型已变化");
    }
    const afterSameModelCommit = selection?.afterSameModelCommit;
    const baseModel = this.resolveBaseModel(runtime, selection?.targetModel);
    if (!baseModel) return;
    const effective = this.desired && isFastModeAvailable(baseModel, runtime.fastModels);
    let restore: (() => void) | undefined;
    try {
      const model = createFastSessionModel(baseModel, effective);
      const current = this.host.currentModel();
      const sameModel = current?.provider === model.provider && current.id === model.id;
      let prepared: PreparedFastModel | undefined;
      if (sameModel && this.host.prepareSameModel) {
        prepared = await this.host.prepareSameModel(model);
        prepared.validate();
        // 鉴权会让出执行权；引用未变也可能已经 reload，显式选模不能提交旧目录中的配置。
        this.assertSelectionRuntimeCurrent(runtime, selection);
      } else {
        await this.host.setModel(model, () => {
          this.assertSelectionRuntimeCurrent(runtime, selection);
          // 鉴权及版本复核通过后、SDK 修改内存前才捕获，失效任务不撤销等待期间的扩展提交。
          restore = this.host.captureRuntime?.();
        });
      }
      if (this.persistedRevision < this.revision) {
        const revision = this.revision;
        this.host.appendState(this.desired);
        this.persistedRevision = revision;
      }
      // 同模型路径在鉴权、状态写入均成功后才替换内存副本，且中间不再 await。
      if (prepared) {
        // 只有鉴权/引用校验已通过、即将执行本次替换时才捕获，不能撤销等待期间扩展的提交。
        if (afterSameModelCommit) restore = this.host.captureRuntime?.();
        prepared.commit();
        afterSameModelCommit?.();
      }
      this.applied = this.desired;
    } catch (error) {
      // SDK 选模或同步档位写入可能先改内存再落盘；只恢复本次提交捕获的状态。
      restore?.();
      throw error;
    }
  }

  private resolveBaseModel(runtime: FastRuntimeSnapshot, targetModel?: FastModelTarget): ModelLike | undefined {
    const current = targetModel ?? this.host.currentModel();
    return current ? runtime.catalogModel(current.provider, current.id) : undefined;
  }
}
