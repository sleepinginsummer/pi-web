import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSessionShadowMindEnabled, type ShadowStateEntryLike } from "./shadow-session-protocol";


type ShadowExtensionCommand = {
  name?: string;
  sourceInfo?: { path?: string; source?: string };
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
};

export function isShadowMindCommand(command: Pick<ShadowExtensionCommand, "name" | "sourceInfo">): boolean {
  if (command.name !== "shadow") return false;
  const provenance = `${command.sourceInfo?.path ?? ""} ${command.sourceInfo?.source ?? ""}`.toLowerCase();
  return provenance.includes("pi-shadow-mind");
}

export type ShadowSessionSettingHost = {
  entries: () => readonly ShadowStateEntryLike[];
  appendState: (enabled: boolean) => void;
  commands: () => readonly ShadowExtensionCommand[];
  createCommandContext: () => ExtensionCommandContext;
};

/** 将持久化会话状态与 Shadow 扩展实例保持一致。 */
export class ShadowSessionSetting {
  private applied = true;
  private desired: boolean;
  private persisted: boolean;
  private revision = 0;
  private persistedRevision = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: ShadowSessionSettingHost) {
    this.desired = readSessionShadowMindEnabled(host.entries());
    this.persisted = this.desired;
  }
  get current(): boolean {
    return this.applied;
  }

  get available(): boolean {
    return this.host.commands().some(isShadowMindCommand);
  }
  async restoreAfterRuntimeReset(): Promise<void> {
    await this.enqueue(async () => {
      // runtime 重建默认开启；重置与 reconcile 必须和用户切换共用同一队列。
      this.applied = true;
      if (!this.available) {
        this.applied = this.desired;
        return;
      }
      await this.applyDesired();
    });
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (!this.available) throw new Error("当前会话未加载 Shadow Mind 扩展");
    this.desired = enabled;
    const requestRevision = this.revision + 1;
    this.revision = requestRevision;
    try {
      await this.enqueue();
      return this.applied;
    } catch (error) {
      // 只回滚仍为最新的失败请求，不能覆盖执行期间到达的新目标。
      if (this.revision === requestRevision) this.desired = this.applied;
      throw error;
    }
  }

  private enqueue(task: () => Promise<void> = () => this.applyDesired()): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(task);
    return this.queue;
  }

  private async applyDesired(): Promise<void> {
    while (this.applied !== this.desired) {
      const target = this.desired;
      await this.invoke(target ? "resume" : "pause");
      this.applied = target;
    }
    if (this.persistedRevision < this.revision) {
      const revision = this.revision;
      try {
        this.host.appendState(this.applied);
        this.persisted = this.applied;
        this.persistedRevision = revision;
      } catch (error) {
        // runtime 已切换但 entry 未落盘：执行反向命令，恢复到最后持久化状态。
        try {
          await this.invoke(this.persisted ? "resume" : "pause");
          this.applied = this.persisted;
          if (this.revision === revision) this.desired = this.persisted;
        } catch (compensationError) {
          throw new AggregateError([error, compensationError], "Shadow Mind 状态持久化失败，且 runtime 补偿失败");
        }
        throw error;
      }
    }
  }

  private async invoke(action: "pause" | "resume"): Promise<void> {
    const command = this.host.commands().find(isShadowMindCommand);
    if (!command) throw new Error("当前会话未加载 Shadow Mind 扩展");
    await command.handler(action, this.host.createCommandContext());
  }
}

export async function restoreShadowSessionSettingSafely(
  setting: ShadowSessionSetting,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await setting.restoreAfterRuntimeReset();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
