import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeSlashes } from "./allowed-roots";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import { isValidSessionId } from "./session-file-references-core";

export interface RecordedArtifactTarget {
  logicalPath: string;
  realPath: string;
  dev: number;
  ino: number;
  recordedAt: number;
}

interface ArtifactTargetsFile {
  version: 1;
  targets: Record<string, RecordedArtifactTarget>;
}

export function getArtifactTargetsStoreDir(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-session-artifact-targets");
}

function getSessionTargetsFilePath(sessionId: string, storeDir: string): string {
  return join(storeDir, `${sessionId}.json`);
}

function readTargetsFileSync(filePath: string): Record<string, RecordedArtifactTarget> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ArtifactTargetsFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.targets || typeof parsed.targets !== "object") {
      return {};
    }
    return parsed.targets;
  } catch {
    return {};
  }
}

/**
 * 在工具写入成功时记录每个本地产物当时的真实路径与 inode 信息，
 * 用于后续删除时绑定写入时刻的真实目标，防止父目录事后被替换为符号链接导致误删其他文件。
 */
export async function recordSessionArtifactTargets(
  sessionId: string,
  logicalPaths: readonly string[],
  storeDir = getArtifactTargetsStoreDir(),
): Promise<void> {
  if (!isValidSessionId(sessionId) || logicalPaths.length === 0) return;

  const updates: Array<[string, RecordedArtifactTarget]> = [];
  for (const rawPath of logicalPaths) {
    const logicalPath = resolve(rawPath);
    try {
      const stat = await lstat(logicalPath);
      if (!stat.isFile()) continue;
      const realPath = await realpath(logicalPath);
      updates.push([
        normalizeSlashes(logicalPath),
        {
          logicalPath,
          realPath,
          dev: Number(stat.dev),
          ino: Number(stat.ino),
          recordedAt: Date.now(),
        },
      ]);
    } catch {
      // 文件不存在或不可访问时跳过
    }
  }
  if (updates.length === 0) return;

  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const filePath = getSessionTargetsFilePath(sessionId, storeDir);
  await withPrivateFileLock(filePath, () => {
    const existing = readTargetsFileSync(filePath);
    for (const [key, record] of updates) {
      existing[key] = record;
    }
    const payload: ArtifactTargetsFile = { version: 1, targets: existing };
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  });
}

/** 读取某会话写入时刻记录的产物真实目标映射表。 */
export function readRecordedArtifactTargets(
  sessionId: string,
  storeDir = getArtifactTargetsStoreDir(),
): Map<string, RecordedArtifactTarget> {
  if (!isValidSessionId(sessionId)) return new Map();
  const filePath = getSessionTargetsFilePath(sessionId, storeDir);
  const raw = readTargetsFileSync(filePath);
  const map = new Map<string, RecordedArtifactTarget>();
  for (const [key, record] of Object.entries(raw)) {
    if (
      record
      && typeof record.logicalPath === "string"
      && typeof record.realPath === "string"
      && typeof record.dev === "number"
      && typeof record.ino === "number"
    ) {
      map.set(key, record);
    }
  }
  return map;
}
