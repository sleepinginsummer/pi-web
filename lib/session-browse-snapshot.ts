import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { projectSessionTree } from "./session-tree-projection";
import type { SessionEntry, SessionTreeNode } from "./types";

export interface SessionBrowseSnapshot {
  entries: SessionEntry[];
  leafId: string | null;
  tree: SessionTreeNode[];
  filePath: string;
  version: string;
  cacheStatus: "hit" | "miss" | "live";
  resolveMs: number;
  readMs: number;
}

interface CachedSnapshot {
  snapshot: Omit<SessionBrowseSnapshot, "cacheStatus" | "resolveMs" | "readMs">;
  estimatedBytes: number;
  lastAccessedAt: number;
}

interface ParsedSnapshot extends CachedSnapshot {
  readMs: number;
}

const MAX_CACHED_SESSIONS = 8;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;

declare global {
  var __piSessionBrowseCache: Map<string, CachedSnapshot> | undefined;
  var __piSessionBrowseInflight: Map<string, Promise<ParsedSnapshot>> | undefined;
}

class SessionFileChangedError extends Error {}

function cache(): Map<string, CachedSnapshot> {
  globalThis.__piSessionBrowseCache ??= new Map();
  return globalThis.__piSessionBrowseCache;
}

function inflight(): Map<string, Promise<ParsedSnapshot>> {
  globalThis.__piSessionBrowseInflight ??= new Map();
  return globalThis.__piSessionBrowseInflight;
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

/** 文件版本同时包含身份、长度和纳秒级变更时间，避免把重写误判为追加。 */
function fileFingerprint(filePath: string): string {
  const stats = statSync(filePath, { bigint: true });
  const raw = [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  return createHash("sha256").update(raw).digest("base64url").slice(0, 22);
}

function liveVersion(entries: readonly SessionEntry[], leafId: string | null): string {
  const last = entries.at(-1);
  const raw = [entries.length, leafId ?? "", last?.id ?? "", last?.timestamp ?? ""].join(":");
  return `live-${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}`;
}

function evictCache(): void {
  const entries = [...cache().entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
  let totalBytes = entries.reduce((sum, [, value]) => sum + value.estimatedBytes, 0);
  while (entries.length > MAX_CACHED_SESSIONS || totalBytes > MAX_CACHED_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    cache().delete(oldest[0]);
    totalBytes -= oldest[1].estimatedBytes;
  }
}

async function parseStableFile(filePath: string, expectedVersion: string): Promise<ParsedSnapshot> {
  // 先让同一事件循环中的 context/details 请求登记 inflight，再执行同步 SDK 解析。
  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedAt = performance.now();
  const manager = SessionManager.open(filePath);
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const leafId = manager.getLeafId();
  const tree = projectSessionTree(manager.getTree() as unknown as SessionTreeNode[]);
  const actualVersion = fileFingerprint(filePath);
  if (actualVersion !== expectedVersion) {
    throw new SessionFileChangedError("会话文件在读取期间发生变化");
  }
  return {
    snapshot: { entries, leafId, tree, filePath, version: actualVersion },
    estimatedBytes: Math.max(statSync(filePath).size, 1),
    lastAccessedAt: Date.now(),
    readMs: elapsedMs(startedAt),
  };
}

export async function readSessionBrowseSnapshot(sessionId: string): Promise<SessionBrowseSnapshot | null> {
  const startedAt = performance.now();
  const rpc = getRpcSession(sessionId);
  const liveRpc = rpc?.isAlive() ? rpc : undefined;
  if (liveRpc) {
    const manager = liveRpc.inner.sessionManager;
    const readStartedAt = performance.now();
    const entries = manager.getEntries() as unknown as SessionEntry[];
    const leafId = manager.getLeafId();
    return {
      entries,
      leafId,
      tree: projectSessionTree(manager.getTree() as unknown as SessionTreeNode[]),
      filePath: liveRpc.sessionFile || manager.getSessionFile() || "",
      version: liveVersion(entries, leafId),
      cacheStatus: "live",
      resolveMs: 0,
      readMs: elapsedMs(readStartedAt),
    };
  }

  const filePath = await resolveSessionPath(sessionId);
  const resolveMs = elapsedMs(startedAt);
  if (!filePath) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const version = fileFingerprint(filePath);
    const key = `${filePath}\0${version}`;
    const existing = cache().get(key);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return { ...existing.snapshot, cacheStatus: "hit", resolveMs, readMs: 0 };
    }

    let pending = inflight().get(key);
    if (!pending) {
      pending = parseStableFile(filePath, version);
      inflight().set(key, pending);
    }
    try {
      const parsed = await pending;
      parsed.lastAccessedAt = Date.now();
      for (const [cachedKey, value] of cache()) {
        if (value.snapshot.filePath === filePath && cachedKey !== key) cache().delete(cachedKey);
      }
      cache().set(key, parsed);
      evictCache();
      return { ...parsed.snapshot, cacheStatus: "miss", resolveMs, readMs: parsed.readMs };
    } catch (error) {
      if (!(error instanceof SessionFileChangedError) || attempt === 1) throw error;
    } finally {
      if (inflight().get(key) === pending) inflight().delete(key);
    }
  }
  throw new Error("会话文件读取失败");
}

export function sessionVersionEtag(version: string): string {
  return `"${version}"`;
}

/** 仅供测试释放跨用例的 globalThis 缓存。 */
export function resetSessionBrowseCacheForTests(): void {
  globalThis.__piSessionBrowseCache = undefined;
  globalThis.__piSessionBrowseInflight = undefined;
}
