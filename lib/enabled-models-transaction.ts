import { join } from "path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock } from "./atomic-file";

/** 跨进程串行化整个读取、编辑、写入事务；每次拿锁后重新读取，禁止复用旧 SettingsManager。 */
export function withEnabledModelsSettings<T>(
  cwd: string,
  agentDir: string,
  operation: (settings: SettingsManager) => Promise<T>,
): Promise<T> {
  // SDK 自己会锁 settings.json；这里使用独立事务锁，避免同进程对同一锁重入死锁。
  return withPrivateFileLock(join(agentDir, "pi-web-enabled-models-transaction"), () =>
    operation(SettingsManager.create(cwd, agentDir)));
}
