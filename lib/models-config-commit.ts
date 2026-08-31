import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";
import {
  getModelCapabilitiesPath,
  extractFastModelCapabilities,
  mergeFastModelCapabilities,
  readFastModelCapabilities,
  writeFastModelCapabilities,
} from "./model-capabilities";
import {
  getModelsConfigPath,
  readModelsConfig,
  writeModelsConfig,
} from "./models-config-store";

interface FileSnapshot {
  existed: boolean;
  content?: string;
}

export interface ModelsConfigCommitPaths {
  modelsPath?: string;
  capabilitiesPath?: string;
}

export interface ModelsConfigCommitDependencies {
  writeModels?: typeof writeModelsConfig;
  writeCapabilities?: typeof writeFastModelCapabilities;
}

export interface ModelsConfigSnapshot {
  modelsConfig: Record<string, unknown>;
  fastModels: ReadonlySet<string>;
  generation: string;
}


function captureFile(path: string): FileSnapshot {
  return existsSync(path)
    ? { existed: true, content: readFileSync(path, "utf8") }
    : { existed: false };
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.content) {
    writePrivateFileAtomicSync(path, snapshot.content);
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

async function acquireModelsConfigLock(modelsPath: string): Promise<{
  release: () => Promise<void>;
  throwIfCompromised: () => void;
  isCompromised: () => boolean;
}> {
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(dirname(modelsPath), {
    realpath: false,
    lockfilePath: `${modelsPath}.pi-web.lock`,
    retries: { retries: 60, factor: 1, minTimeout: 10, maxTimeout: 50 },
    stale: 30_000,
    onCompromised: (error) => {
      compromisedError = error;
    },
  });
  return {
    release,
    throwIfCompromised: () => {
      if (compromisedError) throw compromisedError;
    },
    isCompromised: () => compromisedError !== undefined,
  };
}


/** 短锁内读取不可变配对快照，调用方不得在锁内执行 SDK 或扩展逻辑。 */
export async function readModelsConfigSnapshot(
  paths: ModelsConfigCommitPaths = {},
): Promise<ModelsConfigSnapshot> {
  const modelsPath = paths.modelsPath ?? getModelsConfigPath();
  const capabilitiesPath = paths.capabilitiesPath ?? getModelCapabilitiesPath();
  const { release, throwIfCompromised } = await acquireModelsConfigLock(modelsPath);
  try {
    throwIfCompromised();
    const modelsRaw = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : "";
    const capabilitiesRaw = existsSync(capabilitiesPath) ? readFileSync(capabilitiesPath, "utf8") : "";
    const snapshot = {
      modelsConfig: readModelsConfig(modelsPath),
      fastModels: readFastModelCapabilities(capabilitiesPath),
      generation: createHash("sha256")
        .update(modelsRaw)
        .update("\0")
        .update(capabilitiesRaw)
        .digest("hex"),
    };
    throwIfCompromised();
    return snapshot;
  } finally {
    await release();
  }
}

/** 在与 PUT 相同的跨进程锁内读取模型配置与能力 sidecar。 */
export async function readModelsConfigWithCapabilities(
  paths: ModelsConfigCommitPaths = {},
): Promise<Record<string, unknown>> {
  const { modelsConfig, fastModels } = await readModelsConfigSnapshot(paths);
  return mergeFastModelCapabilities(modelsConfig, fastModels);
}

/**
 * 持有跨进程文件锁时提交 SDK 模型配置与 pi-web 能力 sidecar。
 * 任一步失败都按原始字节恢复两份文件，避免 API 返回失败后留下部分生效状态。
 */
export async function commitModelsConfigWithCapabilities(
  data: Record<string, unknown>,
  paths: ModelsConfigCommitPaths = {},
  dependencies: ModelsConfigCommitDependencies = {},
): Promise<void> {
  const modelsPath = paths.modelsPath ?? getModelsConfigPath();
  const capabilitiesPath = paths.capabilitiesPath ?? getModelCapabilitiesPath();
  const { release, throwIfCompromised, isCompromised } = await acquireModelsConfigLock(modelsPath);

  try {
    throwIfCompromised();
    const modelsSnapshot = captureFile(modelsPath);
    const capabilitiesSnapshot = captureFile(capabilitiesPath);
    const { modelsConfig, fastModels } = extractFastModelCapabilities(data);

    try {
      throwIfCompromised();
      (dependencies.writeModels ?? writeModelsConfig)(modelsConfig, modelsPath);
      throwIfCompromised();
      (dependencies.writeCapabilities ?? writeFastModelCapabilities)(fastModels, capabilitiesPath);
      throwIfCompromised();
    } catch (commitError) {
      if (isCompromised()) throw commitError;
      const rollbackErrors: unknown[] = [];
      for (const [path, snapshot] of [
        [modelsPath, modelsSnapshot],
        [capabilitiesPath, capabilitiesSnapshot],
      ] as const) {
        try {
          restoreFile(path, snapshot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      invalidateModelsCache();
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [commitError, ...rollbackErrors],
          "模型配置提交失败，且未能完整恢复旧配置",
        );
      }
      throw commitError;
    }
  } finally {
    await release();
  }
}
