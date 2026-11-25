import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { normalizeSlashes } from "./allowed-roots";
import { isWindowsAbsolutePath } from "./file-access";
import { hasParentDirectorySegment } from "./path-security";
import { samePath } from "./paths";
import { getRpcSession } from "./rpc-manager";
import {
  getArtifactTargetsStoreDir,
  readRecordedArtifactTargets,
} from "./session-artifact-targets";
import { collectSessionArtifactsFromEntries, type SessionArtifact } from "./session-artifacts";
import { isValidSessionId } from "./session-file-references-core";
import { openSessionManager, readSessionHeader, resolveSessionPath } from "./session-reader";
import type { SessionEntry } from "./types";

export interface SessionEntriesSnapshot {
  cwd?: string;
  entries: SessionEntry[];
}

export type SessionEntriesLoader = (sessionId: string) => Promise<SessionEntriesSnapshot | null>;

export interface SessionArtifactServerOptions {
  loader?: SessionEntriesLoader;
  targetStoreDir?: string;
}

/**
 * 默认从存活 AgentSession 或磁盘 .jsonl 加载当前活动分支的会话条目；找不到会话返回 null。
 * 使用 getBranch() 而非 getEntries()，避免已放弃的旧分支产物混入当前会话。
 */
export async function loadSessionEntriesSnapshot(sessionId: string): Promise<SessionEntriesSnapshot | null> {
  if (!isValidSessionId(sessionId)) return null;
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    return {
      cwd: live.cwd,
      entries: live.inner.sessionManager.getBranch() as unknown as SessionEntry[],
    };
  }
  const sessionPath = await resolveSessionPath(sessionId);
  if (!sessionPath) return null;
  const header = readSessionHeader(sessionPath);
  const entries = openSessionManager(sessionPath).getBranch() as unknown as SessionEntry[];
  return {
    cwd: header?.cwd,
    entries,
  };
}

/**
 * macOS 上仅对系统级根别名（/var、/tmp、/etc -> /private/*）做规范化，
 * 以便未记录写入目标的历史会话在不放行用户目录符号链接的前提下仍能识别系统临时目录路径。
 */
function canonicalizeSystemRootAlias(absPath: string): string {
  const resolved = resolve(absPath);
  if (process.platform !== "darwin") return resolved;
  for (const prefix of ["/var/", "/tmp/", "/etc/"]) {
    if (resolved.startsWith(prefix)) {
      return `/private${resolved}`;
    }
  }
  return resolved;
}

/**
 * 逐段检查路径上是否存在任何符号链接（含所有父目录与末级文件本身）。
 */
async function hasSymlinkComponent(absPath: string): Promise<boolean> {
  const normalized = resolve(absPath);
  const root = parse(normalized).root;
  let cursor = normalized;
  while (cursor && cursor !== root) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) return true;
    } catch {
      return true;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

/**
 * 列出当前会话活动分支上的完整产物列表（含所有早期分页消息中的网页产物与本地文件），
 * 并自动排除磁盘上已不存在的本地产物。
 */
export async function listSessionArtifacts(
  sessionId: string,
  options: SessionArtifactServerOptions = {},
): Promise<
  | { ok: true; artifacts: SessionArtifact[]; existingPaths: string[] }
  | { ok: false; status: number; error: string }
> {
  const loader = options.loader ?? loadSessionEntriesSnapshot;
  const snapshot = await loader(sessionId);
  if (!snapshot) {
    return { ok: false, status: 404, error: "Session not found" };
  }
  const allArtifacts = collectSessionArtifactsFromEntries(snapshot.entries, snapshot.cwd);
  const artifacts: SessionArtifact[] = [];
  const existingPaths: string[] = [];
  for (const artifact of allArtifacts) {
    if (artifact.kind === "web") {
      artifacts.push(artifact);
      continue;
    }
    try {
      const stat = await lstat(artifact.path);
      if (stat.isFile()) {
        artifacts.push(artifact);
        existingPaths.push(artifact.path);
      }
    } catch {
      // 文件已不存在，跳过
    }
  }
  return { ok: true, artifacts, existingPaths };
}

/** 兼容旧调用方：返回当前磁盘上仍然存在的本地产物路径集合。 */
export async function listExistingSessionArtifactPaths(
  sessionId: string,
  loader: SessionEntriesLoader = loadSessionEntriesSnapshot,
): Promise<{ ok: true; existingPaths: string[] } | { ok: false; status: number; error: string }> {
  const result = await listSessionArtifacts(sessionId, { loader });
  if (!result.ok) return result;
  return { ok: true, existingPaths: result.existingPaths };
}

export type VerifyDeleteArtifactResult =
  | { ok: true; resolvedPath: string; matchedArtifact: SessionArtifact }
  | { ok: false; status: number; error: string };

/**
 * 严格核验待删除文件是否确为该会话活动分支成功写出的本地产物，且未被符号链接重定向：
 * 1. 会话必须真实存在；
 * 2. 目标必须是已存在的普通文件（拒绝目录与符号链接）；
 * 3. 若存在写入时刻记录的真实目标（realPath），当前 realpath 必须与写入时记录的真实目标严格一致；
 * 4. 若无写入时刻记录（历史/外部会话），则拒绝任何经过父目录或末级符号链接重定向的路径，
 *    防止父目录事后被替换为符号链接而误删未授权文件。
 */
export async function verifySessionArtifactForDeletion(
  sessionId: string,
  rawPath: string,
  optionsOrLoader: SessionArtifactServerOptions | SessionEntriesLoader = {},
): Promise<VerifyDeleteArtifactResult> {
  const options: SessionArtifactServerOptions = typeof optionsOrLoader === "function"
    ? { loader: optionsOrLoader }
    : optionsOrLoader;
  const loader = options.loader ?? loadSessionEntriesSnapshot;
  const targetStoreDir = options.targetStoreDir ?? getArtifactTargetsStoreDir();

  if (!isValidSessionId(sessionId)) {
    return { ok: false, status: 400, error: "Invalid session id" };
  }
  const trimmed = rawPath.trim();
  if (!trimmed || (!isAbsolute(trimmed) && !isWindowsAbsolutePath(trimmed)) || hasParentDirectorySegment(trimmed)) {
    return { ok: false, status: 400, error: "Invalid file path" };
  }

  const snapshot = await loader(sessionId);
  if (!snapshot) {
    return { ok: false, status: 404, error: "Session not found" };
  }

  const targetPath = resolve(trimmed);
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }
  if (!targetStat.isFile()) {
    return { ok: false, status: 400, error: "Only regular files can be deleted" };
  }

  let realTarget: string;
  try {
    realTarget = await realpath(targetPath);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }

  const artifacts = collectSessionArtifactsFromEntries(snapshot.entries, snapshot.cwd);
  const recordedTargets = readRecordedArtifactTargets(sessionId, targetStoreDir);
  let sawRedirectedArtifact = false;

  for (const artifact of artifacts) {
    if (artifact.kind === "web") continue;
    const candidateLogical = resolve(artifact.path);
    const recorded = recordedTargets.get(normalizeSlashes(candidateLogical));

    if (recorded) {
      // 有写入时刻记录：强制绑定到写入时记录的真实目标路径
      if (samePath(realTarget, recorded.realPath)) {
        // 同时确认写入时的真实目标路径本身如今仍无符号链接重定向且仍为普通文件
        if (!(await hasSymlinkComponent(recorded.realPath))) {
          return { ok: true, resolvedPath: recorded.realPath, matchedArtifact: artifact };
        }
        sawRedirectedArtifact = true;
      } else if (samePath(targetPath, candidateLogical)) {
        sawRedirectedArtifact = true;
      }
      continue;
    }

    // 无写入时刻记录（如历史会话）：无法确认原目标，拒绝任何经过符号链接重定向的路径
    const expectedCanonical = canonicalizeSystemRootAlias(candidateLogical);
    const requestCanonical = canonicalizeSystemRootAlias(targetPath);
    if (
      samePath(realTarget, expectedCanonical)
      && samePath(requestCanonical, expectedCanonical)
      && !(await hasSymlinkComponent(expectedCanonical))
    ) {
      return { ok: true, resolvedPath: realTarget, matchedArtifact: artifact };
    }
    if (samePath(targetPath, candidateLogical) || samePath(requestCanonical, expectedCanonical)) {
      sawRedirectedArtifact = true;
    }
  }

  if (sawRedirectedArtifact) {
    return {
      ok: false,
      status: 403,
      error: "Access denied: artifact path is redirected via symbolic link and cannot be verified",
    };
  }

  return { ok: false, status: 403, error: "Access denied: file is not an artifact written by this session" };
}
