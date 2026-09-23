import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, type Dirent, fstatSync, openSync, readSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { isAbsolute, join, normalize as normalizePath, relative, resolve as resolvePath, sep } from "path";
import type { AgentMessage, ImageContent, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { getThinkingPreview } from "./message-display";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";
import { resolveProject, type ProjectInfo } from "./worktree";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";
import { invalidateSessionDirectorySnapshot, listSessionsIncremental, type ScannedSessionInfo } from "./session-list-scanner";

export { getAgentDir };

const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_RELATION_MAX_BYTES = 256 * 1024;
const SESSION_RELATION_MAX_LINES = 2;
const SESSION_RESULT_MAX_BYTES = 256 * 1024;
// Bounded probe for the newest entry id; never reads a whole session file.
const SESSION_TAIL_PROBE_MAX_BYTES = 64 * 1024;

function readBoundedLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let newlineCount = 0;
    let reachedEof = false;

    while (position < maxBytes && newlineCount < maxLines) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      let end = data.length;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        newlineCount += 1;
        if (newlineCount === maxLines) {
          end = index + 1;
          break;
        }
      }
      chunks.push(data.subarray(0, end));
    }

    const source = Buffer.concat(chunks).toString("utf8");
    const lines = source.split("\n");
    if (!reachedEof && !source.endsWith("\n")) lines.pop();
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function readBoundedTailLines(filePath: string, maxBytes: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const start = Math.max(0, fileSize - maxBytes);
    const buffer = Buffer.allocUnsafe(fileSize - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    if (bytesRead === 0) return [];

    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a) lines.shift();
    }
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function parseSessionEntries(lines: readonly string[]): SessionEntry[] {
  return lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as SessionEntry;
      return [entry];
    } catch {
      return [];
    }
  });
}

/**
 * Entry id carried by one serialized JSONL line, or undefined when the line is
 * the session header, malformed, or a torn trailing write mid-append.
 *
 * The header carries the session id rather than an entry id, and the SDK's entry
 * index excludes it — treating it as an entry would evict a fresh wrapper.
 */
function readEntryId(line: string): string | undefined {
  try {
    const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
    if (entry.type === "session") return undefined;
    return typeof entry.id === "string" && entry.id ? entry.id : undefined;
  } catch {
    return undefined;
  }
}

/** 从文件尾按块倒查完整 JSONL 行；超长记录按需延伸，不截断 64 KB 边界。 */
export function readLatestSessionEntryId(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  let fd: number;
  try { fd = openSync(filePath, "r"); } catch { return undefined; }
  try {
    let position = fstatSync(fd).size;
    // 从右向左保存当前跨块记录的片段；只在遇到换行后拼接一次。
    let fragments: Buffer[] = [];
    while (position > 0) {
      const size = Math.min(SESSION_TAIL_PROBE_MAX_BYTES, position);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      const count = readSync(fd, chunk, 0, size, position);
      let end = count;
      for (let cursor = count - 1; cursor >= 0; cursor -= 1) {
        if (chunk[cursor] !== 0x0a) continue;
        const candidate = Buffer.concat([chunk.subarray(cursor + 1, end), ...fragments.reverse()]);
        const id = readEntryId(candidate.toString("utf8").replace(/\r$/, ""));
        if (id) return id;
        fragments = [];
        end = cursor;
      }
      fragments.push(chunk.subarray(0, end));
    }
    return readEntryId(Buffer.concat(fragments.reverse()).toString("utf8").replace(/\r$/, ""));
  } finally {
    closeSync(fd);
  }
}

function readSessionRelationEntries(filePath: string): SessionEntry[] {
  const prefixEntries = parseSessionEntries(
    readBoundedLines(filePath, SESSION_RELATION_MAX_BYTES, SESSION_RELATION_MAX_LINES).slice(1),
  );
  const isSubagent = prefixEntries.some((entry) => (
    entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE
  ));
  if (!isSubagent) return prefixEntries;

  return [
    ...prefixEntries,
    ...parseSessionEntries(readBoundedTailLines(filePath, SESSION_RESULT_MAX_BYTES)),
  ];
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.branch ? { branch: project.branch } : {}),
      ...(project?.isWorktree ? { isWorktree: true } : {}),
    };
  });
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

type ScannedSubagent = NonNullable<ReturnType<typeof readSubagentRun>>;

function resolveScannedSessionRelation(
  scanned: ScannedSessionInfo,
  pathToId: Map<string, string>,
): { originSessionId?: string; subagent: ScannedSubagent | null } {
  const originSessionId = scanned.parentSessionPath
    ? pathToId.get(sessionPathKey(scanned.parentSessionPath))
    : undefined;
  if (!scanned.parentSessionPath) return { originSessionId, subagent: null };

  try {
    const subagent = readSubagentRun(readSessionRelationEntries(scanned.path), scanned.id, scanned.path);
    return { originSessionId, subagent };
  } catch {
    // Malformed or concurrently removed session.
    return { originSessionId, subagent: null };
  }
}

function mapScannedSession(
  scanned: ScannedSessionInfo,
  pathToId: Map<string, string>,
): SessionInfo {
  cacheSessionPath(scanned.id, scanned.path);
  const { originSessionId, subagent } = resolveScannedSessionRelation(scanned, pathToId);
  const detailsPending = scanned.detailsPending === true;
  return {
    path: scanned.path,
    id: scanned.id,
    cwd: scanned.cwd,
    name: scanned.name,
    created: scanned.created.toISOString(),
    modified: scanned.modified.toISOString(),
    messageCount: scanned.messageCount,
    // A pending row has no first message yet; the placeholder would read as a
    // real "(no messages)" session until the details arrive.
    firstMessage: detailsPending && !scanned.firstMessage
      ? ""
      : scanned.firstMessage || "(no messages)",
    parentSessionId: originSessionId,
    ...(subagent
      ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
      : scanned.parentSessionPath
        ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
        : {}),
    transient: false,
    ...(detailsPending ? { detailsPending: true } : {}),
  };
}

async function buildSessionList(scanned: ScannedSessionInfo[]): Promise<SessionInfo[]> {
  const pathToId = new Map<string, string>();
  for (const session of scanned) pathToId.set(sessionPathKey(session.path), session.id);
  return attachSessionProjectInfo(scanned.map((session) => mapScannedSession(session, pathToId)));
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  return buildSessionList(await listSessionsIncremental());
}

/**
 * Return a cheap catalogue for the first paint. Changed files contribute only
 * header/stat metadata; a normal listAllSessions() call hydrates the exact
 * counts, names, and first messages afterwards.
 */
export async function listSessionSummaries(): Promise<SessionInfo[]> {
  return buildSessionList(await listSessionsIncremental({ deferDetails: true }));
}

export async function listAllSessions(options: { force?: boolean; allowStale?: boolean } = {}): Promise<SessionInfo[]> {
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  const cache = globalThis.__piSessionListCache;
  if (cache && cache.generation === generation && Date.now() - cache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return cache.data;
  }

  // Callers that only need session metadata — mapping search hits onto sidebar
  // rows, for example — can take the previous scan and let the rebuild happen in
  // the background. A rebuild costs hundreds of milliseconds because it re-reads
  // every forked and subagent session, and it is triggered by ordinary agent
  // activity rather than by anything the caller did.
  if (options.allowStale && cache) {
    void listAllSessions().catch(() => undefined);
    return cache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listAllSessions();
    }
    globalThis.__piSessionListCache = { data, ts: Date.now(), generation };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piProjectMetadataRevision: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number; generation: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function defaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function resolvePathWithinDefaultSessions(
  filePath: string,
  sessionsDir = resolvePath(defaultSessionsDir()),
): string | null {
  const candidatePath = resolvePath(filePath);
  const relativePath = relative(sessionsDir, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidatePath
    : null;
}

async function findSessionPathById(sessionId: string): Promise<string | null> {
  // The filename is only a candidate hint; the bounded header check remains
  // authoritative so future layouts and malformed files use the full fallback.
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  let projectDirs: Dirent[];
  const sessionsDir = resolvePath(defaultSessionsDir());
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  let match: string | undefined;
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() && !projectDir.isSymbolicLink()) continue;
    const projectPath = resolvePathWithinDefaultSessions(
      join(sessionsDir, projectDir.name),
      sessionsDir,
    );
    if (!projectPath) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const candidate = resolvePathWithinDefaultSessions(
        join(projectPath, file),
        sessionsDir,
      );
      if (!candidate) continue;
      try {
        if (readSessionHeader(candidate)?.id !== sessionId) continue;
      } catch {
        continue;
      }
      // Do not choose between duplicate candidates; retain the existing
      // catalogue fallback for its current resolution semantics.
      if (match && match !== candidate) return null;
      match = candidate;
    }
  }

  return match ?? null;
}

function findSessionIdByPath(filePath: string): string | undefined {
  if (!filePath.endsWith(".jsonl")) return undefined;
  const candidate = resolvePathWithinDefaultSessions(filePath);
  if (!candidate) return undefined;
  try {
    const sessionId = readSessionHeader(candidate)?.id;
    if (!sessionId) return undefined;
    cacheSessionPath(sessionId, candidate);
    return sessionId;
  } catch {
    return undefined;
  }
}

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  invalidateSessionDirectorySnapshot();
  // 旧快照仍可用于仅需侧栏元数据的查询；代数变更要求完整读取重新构建。
}

export function getSessionListVersion(): number {
  return globalThis.__piSessionListGeneration ?? 0;
}

/** 只更新现有会话列表缓存中的 Git 展示信息，不触发额外的磁盘扫描。 */
export function updateCachedSessionProject(
  cwd: string,
  project: ProjectInfo,
  currentBranch: string | null,
): void {
  globalThis.__piProjectMetadataRevision = (globalThis.__piProjectMetadataRevision ?? 0) + 1;
  const cached = globalThis.__piSessionListCache;
  if (!cached) return;

  let changed = false;
  const data = cached.data.map((session) => {
    if (session.cwd !== cwd) return session;
    changed = true;
    const next: SessionInfo = { ...session, projectRoot: project.projectRoot };
    if (project.isTopLevel) {
      if (currentBranch) next.currentBranch = currentBranch;
      else delete next.currentBranch;
      next.isWorktree = project.isWorktree;
    } else {
      delete next.currentBranch;
      delete next.isWorktree;
    }
    return next;
  });
  if (changed) globalThis.__piSessionListCache = { data, ts: cached.ts, generation: cached.generation };
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

// ---------------------------------------------------------------------------
// Read-only SessionManager cache.
//
// Opening a large session (SessionManager.open -> full JSONL parse + index
// build) costs 150ms for a small session and ~1.1s for an 82MB one. Detail/
// context/pagination routes re-open the same file on every request whenever no
// live runtime wrapper exists, so a fingerprint-validated cache turns repeat
// opens into ~1ms map hits.
//
// Budget: a count cap alone is not enough. Parsed entries retain roughly the
// file's own size in heap (measured: an 82MB session holds ~94MB), so twelve
// large sessions would pin ~1.1GB. Entries are therefore also capped by the
// summed on-disk size of the cached files, and a single session larger than
// SM_CACHE_LIMITS.maxFileBytes is served fresh instead of being cached — one
// oversize session must not evict every useful entry.
//
// Safety: cached managers are READ-ONLY views. Any write path must go through
// a live wrapper or SessionManager.open directly — call openSessionManager
// with { mutable: true } (bypasses the cache) for those. The fingerprint
// (size + mtimeMs) invalidates on external appends (TUI writes), and
// invalidateSessionManagerCache(filePath) is called on delete/rename.
// ---------------------------------------------------------------------------

interface SmCacheEntry {
  sm: unknown;
  fingerprint: string;
  /** On-disk size, the proxy for this entry's retained heap. */
  bytes: number;
}

declare global {
  var __piSmCache: Map<string, SmCacheEntry> | undefined;
}

/**
 * Cache budget. Exported so tests can shrink it to values they can actually
 * produce on disk; production never reassigns these.
 */
export const SM_CACHE_LIMITS = {
  /** Most sessions held at once. */
  maxEntries: 12,
  /** Summed on-disk size of cached sessions. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** A session larger than this is never cached — it would evict everything else. */
  maxFileBytes: 64 * 1024 * 1024,
};

function getSmCache(): Map<string, SmCacheEntry> {
  if (!globalThis.__piSmCache) globalThis.__piSmCache = new Map();
  return globalThis.__piSmCache;
}

function sessionFileStats(filePath: string): { fingerprint: string; bytes: number } | null {
  try {
    const stats = statSync(filePath);
    return { fingerprint: `${stats.size}:${stats.mtimeMs}`, bytes: stats.size };
  } catch {
    return null;
  }
}

/** Evict least-recently-used entries until both the count and byte caps hold. */
function evictSmCache(cache: Map<string, SmCacheEntry>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > SM_CACHE_LIMITS.maxEntries || total > SM_CACHE_LIMITS.maxTotalBytes) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    total -= cache.get(oldestKey)?.bytes ?? 0;
    cache.delete(oldestKey);
  }
}

export function invalidateSessionManagerCache(filePath?: string): void {
  const cache = getSmCache();
  if (filePath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(sessionPathKey(filePath));
}

/**
 * Open a session file, reusing a cached read-only SessionManager when the
 * on-disk fingerprint is unchanged. Pass { mutable: true } when the caller
 * intends to append/branch/rewrite — that path always opens fresh.
 */
export function openSessionManager(
  filePath: string,
  options: { mutable?: boolean } = {},
): SessionManager {
  if (options.mutable) return SessionManager.open(filePath, undefined);

  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  const stats = sessionFileStats(filePath);
  if (stats === null) {
    cache.delete(pathKey);
    return SessionManager.open(filePath, undefined);
  }

  const cached = cache.get(pathKey);
  if (cached && cached.fingerprint === stats.fingerprint) {
    // LRU touch.
    cache.delete(pathKey);
    cache.set(pathKey, cached);
    return cached.sm as SessionManager;
  }

  const sm = SessionManager.open(filePath, undefined);
  if (stats.bytes > SM_CACHE_LIMITS.maxFileBytes) {
    // Too large to hold: drop any stale entry for this path and serve fresh.
    cache.delete(pathKey);
    return sm;
  }
  cache.set(pathKey, { sm, fingerprint: stats.fingerprint, bytes: stats.bytes });
  evictSmCache(cache);
  return sm;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  const targetedPath = await findSessionPathById(sessionId);
  if (targetedPath) {
    cacheSessionPath(sessionId, targetedPath);
    return getPathCache().get(sessionId) ?? null;
  }

  // Unknown layouts, malformed candidates, and duplicate IDs retain the
  // existing authoritative catalogue scan instead of negative-caching a miss.
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  const targetedId = findSessionIdByPath(filePath);
  if (targetedId) return targetedId;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const firstLine = readBoundedLines(filePath, SESSION_HEADER_MAX_BYTES, 1)[0]?.trimEnd();
  if (!firstLine) return null;
  try {
    const header = JSON.parse(firstLine) as SessionHeader;
    return header.type === "session" ? header : null;
  } catch {
    return null;
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = openSessionManager(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function getLatestModelChange(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return null;
}

function getSessionSettings(entries: SessionEntry[], leafId?: string | null): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const branch = sliceActiveBranch(entries, leafId ?? null, entries.length);
  let thinkingLevel: string | undefined;
  let responseModel: SessionContext["model"] | undefined;

  for (let i = branch.length - 1; i >= 0 && (thinkingLevel === undefined || responseModel === undefined); i--) {
    const entry = branch[i];
    if (thinkingLevel === undefined && entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
    if (responseModel === undefined && entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        responseModel = { provider: message.provider, modelId: message.model };
      }
    }
  }

  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: getLatestModelChange(branch) ?? responseModel ?? null,
  };
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
  /** 持久化索引沿完整祖先链解析出的有效设置，避免分页时读取无关消息正文。 */
  effectiveSettings?: Pick<SessionContext, "thinkingLevel" | "model">;
}

type ShadowRunMetadata = {
  model?: string;
  thinkingLevel?: string;
};

/** 汇总一次 Shadow 运行分散在 start/end 事件中的实际模型与思考强度。 */
function collectShadowRunMetadata(entries: SessionEntry[]): ReadonlyMap<string, ShadowRunMetadata> {
  const metadata = new Map<string, ShadowRunMetadata>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "shadow-mind-event") continue;
    const event = entry.data as { kind?: unknown; data?: Record<string, unknown> } | undefined;
    const kind = event?.kind;
    const data = event?.data;
    const runId = data?.runId;
    if (!data || typeof runId !== "string") continue;
    const current = metadata.get(runId) ?? {};
    if (kind === "run-start" && typeof data.model === "string") current.model = data.model;
    if (kind === "run-end" && typeof data.thinkingLevel === "string") current.thinkingLevel = data.thinkingLevel;
    metadata.set(runId, current);
  }
  return metadata;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf } = options;
  // Restrict SDK conversion and the response payload to the requested page.
  const sliced = tail && tail > 0 ? sliceActiveBranch(entries, leafId ?? null, tail, excludeLeaf) : entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of sliced) byId.set(e.id, e);

  const piEntries = sliced as unknown as PiSessionEntry[];
  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );
  // SDK 上下文会过滤扩展 custom 条目；将当前压缩边界之后的可见 Shadow 事件
  // 按原始分支位置补回，避免升级 SDK 后生命周期卡片从历史记录中消失。
  const contextEntryIds = new Set(contextEntries.map((entry) => entry.id));
  const latestCompactionIndex = sliced.findLastIndex((entry) => entry.type === "compaction");
  const visibleCustomEntries = sliced.filter((entry, index) => (
    index > latestCompactionIndex
    && !contextEntryIds.has(entry.id)
    && entry.type === "custom"
    && entry.customType === "shadow-mind-event"
  ));
  const mergedContextEntries = [...contextEntries];
  for (const customEntry of visibleCustomEntries) {
    const rawIndex = sliced.findIndex((entry) => entry.id === customEntry.id);
    const nextVisible = sliced.slice(rawIndex + 1).find((entry) => contextEntryIds.has(entry.id));
    const insertAt = nextVisible
      ? mergedContextEntries.findIndex((entry) => entry.id === nextVisible.id)
      : mergedContextEntries.length;
    mergedContextEntries.splice(insertAt < 0 ? mergedContextEntries.length : insertAt, 0, customEntry as unknown as PiSessionEntry);
  }

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const shadowRunMetadata = collectShadowRunMetadata(sliced);
  for (const entry of mergedContextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options, shadowRunMetadata);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  // Compaction-aware conversion may filter raw entries at the front of a page.
  // Advancing from such a filtered entry would skip it forever on the next page.
  const returnedEntryIds = new Set(entryIds);
  const oldestReturnedEntry = sliced.find((entry) => returnedEntryIds.has(entry.id));
  const oldestCursorEntry = oldestReturnedEntry ?? sliced[0];
  const hasMore = Boolean(tail && tail > 0 && oldestCursorEntry?.parentId);

  return {
    messages,
    entryIds,
    oldestEntryId: oldestCursorEntry?.id ?? null,
    hasMore,
    ...(options.effectiveSettings ?? getSessionSettings(entries, leafId)),
  };
}

/**
 * 按可见消息数限制历史页；工具结果不挤占首屏，但原始记录设有上限。
 * 不突破上限自动补齐完整工具轮次，缺失的祖先由 before 分页获取。
 */
function countsTowardTail(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type !== "message") return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === "user" || role === "assistant";
}

const MIN_RAW_WINDOW_ENTRIES = 200;
const rawWindowCap = (tail: number) => Math.max(MIN_RAW_WINDOW_ENTRIES, tail * 6);

/** 从叶子迭代遍历祖先，避免长会话递归溢出。 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  let visible = 0;
  const rawCap = rawWindowCap(tail);
  while (current) {
    chain.push(current);
    if (countsTowardTail(current)) visible++;
    if (visible >= tail || chain.length >= rawCap) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  chain.reverse();
  return chain;
}
function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function deferHistoricalBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (!("content" in message) || !Array.isArray(message.content)) return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content } as AgentMessage;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content } as AgentMessage;
}

const HISTORICAL_TEXT_PREVIEW_BYTES = 8 * 1024;
const HISTORICAL_TEXT_INLINE_BYTES = 64 * 1024;

function textPreview(text: string): string {
  if (Buffer.byteLength(text) <= HISTORICAL_TEXT_PREVIEW_BYTES) return text;
  let end = Math.min(text.length, HISTORICAL_TEXT_PREVIEW_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > HISTORICAL_TEXT_PREVIEW_BYTES) end -= 1;
  return `${text.slice(0, end)}\n\n[内容过长，展开后加载完整内容]`;
}

function deferredContentUrl(sessionId: string, entryId: string, resource: string, blockIndex?: number): string {
  const query = new URLSearchParams({ resource });
  if (blockIndex !== undefined) query.set("blockIndex", String(blockIndex));
  return `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/content?${query}`;
}

/** 将历史大字段替换为可定位的预览，保证分页条数固定时响应字节数仍有上限。 */
function deferHistoricalLargeContent(message: AgentMessage, sessionId: string | undefined, entryId: string): AgentMessage {
  if (!sessionId) return message;
  if (message.role === "bashExecution") {
    const bytes = Buffer.byteLength(message.output);
    return bytes > HISTORICAL_TEXT_INLINE_BYTES
      ? {
          ...message,
          output: textPreview(message.output),
          deferredOutputUrl: deferredContentUrl(sessionId, entryId, "bash-output"),
          originalOutputBytes: bytes,
        }
      : message;
  }
  if (!("content" in message)) return message;
  if (typeof message.content === "string") {
    const bytes = Buffer.byteLength(message.content);
    if (bytes <= HISTORICAL_TEXT_INLINE_BYTES) return message;
    return {
      ...message,
      content: [{
        type: "text",
        text: textPreview(message.content),
        deferredUrl: deferredContentUrl(sessionId, entryId, "text", 0),
        originalBytes: bytes,
      }],
    } as AgentMessage;
  }
  const content = message.content.map((block, blockIndex) => {
    if (block.type === "text") {
      const bytes = Buffer.byteLength(block.text);
      return bytes > HISTORICAL_TEXT_INLINE_BYTES
        ? {
            ...block,
            text: textPreview(block.text),
            deferredUrl: deferredContentUrl(sessionId, entryId, "text", blockIndex),
            originalBytes: bytes,
          }
        : block;
    }
    if (block.type === "toolCall") {
      const serialized = JSON.stringify(block.input);
      const bytes = Buffer.byteLength(serialized);
      return bytes > HISTORICAL_TEXT_INLINE_BYTES
        ? {
            ...block,
            input: { preview: textPreview(serialized) },
            deferredUrl: deferredContentUrl(sessionId, entryId, "tool-input", blockIndex),
            originalBytes: bytes,
          }
        : block;
    }
    return block;
  });
  const details = "details" in message ? message.details : undefined;
  const boundedDetails = details !== undefined && Buffer.byteLength(JSON.stringify(details)) > HISTORICAL_TEXT_INLINE_BYTES
    ? undefined
    : details;
  return {
    ...message,
    content,
    ...(details !== undefined ? { details: boundedDetails } : {}),
  } as AgentMessage;
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
  shadowRunMetadata: ReadonlyMap<string, ShadowRunMetadata>,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      let message = options.deferToolResultImages
        ? deferHistoricalBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id)
        : normalizeToolCalls(entry.message);
      if (options.deferToolResultImages) message = deferHistoricalLargeContent(message, options.sessionId, entry.id);
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: getThinkingPreview(block.thinking), deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom": {
      if (entry.customType !== "shadow-mind-event") return null;
      const event = entry.data as {
        kind?: unknown;
        data?: {
          runId?: unknown;
          shadowId?: unknown;
          model?: unknown;
          thinkingLevel?: unknown;
          reason?: unknown;
          durationMs?: unknown;
          count?: unknown;
        };
      } | undefined;
      const data = event?.data;
      const runMetadata = typeof data?.runId === "string" ? shadowRunMetadata.get(data.runId) : undefined;
      if (event?.kind === "run-start" && typeof data?.shadowId === "string") {
        return {
          role: "custom",
          customType: "shadow-mind",
          content: data.shadowId,
          display: true,
          details: {
            event: "run-start",
            shadowId: data.shadowId,
            model: typeof data.model === "string" ? data.model : null,
            ...(runMetadata?.thinkingLevel ? { thinkingLevel: runMetadata.thinkingLevel } : {}),
          },
          timestamp: parseEntryTimestamp(entry.timestamp),
        };
      }
      if (event?.kind === "run-end" && typeof data?.shadowId === "string") {
        return {
          role: "custom",
          customType: "shadow-mind",
          content: data.shadowId,
          display: true,
          details: {
            event: "run-end",
            shadowId: data.shadowId,
            ...(runMetadata?.model ? { model: runMetadata.model } : {}),
            ...(typeof data.thinkingLevel === "string" ? { thinkingLevel: data.thinkingLevel } : {}),
            reason: typeof data.reason === "string" ? data.reason : null,
            durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
          },
          timestamp: parseEntryTimestamp(entry.timestamp),
        };
      }
      if (event?.kind === "runs-aborted" && typeof data?.count === "number" && data.count > 0) {
        return {
          role: "custom",
          customType: "shadow-mind",
          content: "",
          display: true,
          details: {
            event: "runs-aborted",
            count: data.count,
            reason: typeof data.reason === "string" ? data.reason : null,
          },
          timestamp: parseEntryTimestamp(entry.timestamp),
        };
      }
      return null;
    }
    default:
      return null;
  }
}
