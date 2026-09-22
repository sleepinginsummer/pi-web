import type { AgentRuntimeSnapshot } from "./agent-state";
import type { AgentMessage, SessionTreeNode } from "./types";

export interface SessionContextSnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  totalActiveMs?: number;
  version: string;
}

export interface SessionDetails {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  version: string;
}

export type SessionContextResult =
  | { kind: "missing" }
  | { kind: "loaded"; snapshot: SessionContextSnapshot; leafId: string | null; cached: boolean };

const SESSION_CONTEXT_CACHE_LIMIT = 24;
const SESSION_CONTEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SESSION_CONTEXT_CACHE_TTL_MS = 60_000;
const PREFETCH_CONCURRENCY = 4;
type LoadedContextResult = Extract<SessionContextResult, { kind: "loaded" }>;
type CachedContext = { result: LoadedContextResult; createdAt: number; lastAccessedAt: number; bytes: number };
const sessionContextCache = new Map<string, CachedContext>();
const sessionContextInflight = new Map<string, Promise<SessionContextResult>>();
const sessionContextGenerations = new Map<string, number>();
const prefetchQueue: string[] = [];
const activePrefetchControllers = new Map<string, AbortController>();
let activePrefetches = 0;

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function waitForConsumer<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function enforceContextCacheLimits(): void {
  const entries = [...sessionContextCache.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
  let totalBytes = entries.reduce((sum, [, value]) => sum + value.bytes, 0);
  while (entries.length > SESSION_CONTEXT_CACHE_LIMIT || totalBytes > SESSION_CONTEXT_CACHE_MAX_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    sessionContextCache.delete(oldest[0]);
    totalBytes -= oldest[1].bytes;
  }
}

function storeContext(sid: string, result: LoadedContextResult): void {
  const serialized = JSON.stringify(result);
  sessionContextCache.set(sid, {
    result: { ...result, cached: true },
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    bytes: new TextEncoder().encode(serialized).byteLength,
  });
  enforceContextCacheLimits();
}

function bumpContextGeneration(sid: string): void {
  sessionContextGenerations.set(sid, (sessionContextGenerations.get(sid) ?? 0) + 1);
}

function drainPrefetchQueue(): void {
  while (activePrefetches < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const sid = prefetchQueue.shift()!;
    if (sessionContextCache.has(sid) || sessionContextInflight.has(sid) || activePrefetchControllers.has(sid)) continue;
    activePrefetches += 1;
    const controller = new AbortController();
    activePrefetchControllers.set(sid, controller);
    void fetchSessionContext(sid, controller.signal, { tail: 50 }).catch(() => {
      sessionContextCache.delete(sid);
    }).finally(() => {
      activePrefetchControllers.delete(sid);
      activePrefetches -= 1;
      drainPrefetchQueue();
    });
  }
}

export function prefetchSessionContext(sid: string): void {
  const cached = sessionContextCache.get(sid);
  // 进行中的请求即使超过 TTL 也不能重排，否则会产生同一 sid 的重复请求。
  if (activePrefetchControllers.has(sid)) return;
  if (cached && Date.now() - cached.createdAt < SESSION_CONTEXT_CACHE_TTL_MS) return;
  sessionContextCache.delete(sid);
  if (!prefetchQueue.includes(sid)) prefetchQueue.push(sid);
  drainPrefetchQueue();
}

function invalidateContextState(sid: string): void {
  bumpContextGeneration(sid);
  activePrefetchControllers.get(sid)?.abort();
  sessionContextCache.delete(sid);
  sessionContextInflight.delete(sid);
  for (let i = prefetchQueue.length - 1; i >= 0; i -= 1) {
    if (prefetchQueue[i] === sid) prefetchQueue.splice(i, 1);
  }
}

/** 列表刷新后让已不存在会话的缓存与进行中请求同时失效。 */
export function pruneSessionContextCache(sessionIds: Iterable<string>): void {
  const valid = new Set(sessionIds);
  const candidates = new Set([
    ...sessionContextCache.keys(),
    ...sessionContextInflight.keys(),
    ...activePrefetchControllers.keys(),
    ...prefetchQueue,
  ]);
  for (const sid of candidates) {
    if (!valid.has(sid)) invalidateContextState(sid);
  }
}

/** 会话产生新消息后清除上下文状态，并取消尚未完成的预取。 */
export function invalidateSessionContext(sid: string): void {
  invalidateContextState(sid);
}



export async function fetchSessionContext(
  sid: string,
  signal: AbortSignal,
  options: { leafId?: string | null; before?: string; deferThinking?: boolean; deferMedia?: boolean; skipCache?: boolean; tail?: number } = {},
): Promise<SessionContextResult> {
  const params = new URLSearchParams();
  if (options.leafId) params.set("leafId", options.leafId);
  if (options.deferThinking !== false) params.set("deferThinking", "1");
  if (options.deferMedia !== false) params.set("deferMedia", "1");
  if (options.before) params.set("before", options.before);
  if (options.tail) params.set("tail", String(options.tail));
  const cacheable = !options.leafId && !options.before;
  const knownCached = cacheable ? sessionContextCache.get(sid) : undefined;
  const cached = !options.skipCache ? knownCached : undefined;
  if (cached) {
    if (Date.now() - cached.createdAt < SESSION_CONTEXT_CACHE_TTL_MS) {
      cached.lastAccessedAt = Date.now();
      return cached.result;
    }
    sessionContextCache.delete(sid);
  }
  const request = async (): Promise<SessionContextResult> => {
    const generation = sessionContextGenerations.get(sid) ?? 0;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, {
      signal: cacheable && !options.skipCache ? undefined : signal,
      headers: options.skipCache && knownCached
        ? { "If-None-Match": `"${knownCached.result.snapshot.version}"` }
        : undefined,
    });
    if (response.status === 304 && knownCached) {
      knownCached.createdAt = Date.now();
      knownCached.lastAccessedAt = Date.now();
      return knownCached.result;
    }
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { context: Omit<SessionContextSnapshot, "version">; leafId: string | null; totalActiveMs?: number; version?: string };
    const version = payload.version ?? response.headers.get("X-Session-Version");
    if (!version) throw new Error("服务端会话上下文缺少版本");
    const entryIds = payload.context.entryIds ?? [];
    if (payload.context.messages.length !== entryIds.length) throw new Error("服务端会话上下文的 messages 与 entryIds 长度不一致");
    if (payload.context.oldestEntryId !== null && typeof payload.context.oldestEntryId !== "string") {
      throw new Error("服务端会话上下文缺少有效的 oldestEntryId");
    }
    if (typeof payload.context.hasMore !== "boolean") throw new Error("服务端会话上下文缺少有效的 hasMore");
    const result: LoadedContextResult = {
      kind: "loaded",
      snapshot: { ...payload.context, entryIds, totalActiveMs: payload.totalActiveMs, version },
      leafId: payload.leafId,
      cached: false,
    };
    if (cacheable && (sessionContextGenerations.get(sid) ?? 0) === generation) storeContext(sid, result);
    return result;
  };

  if (!cacheable || options.skipCache) return request();
  let pending = sessionContextInflight.get(sid);
  if (!pending) {
    pending = request().finally(() => {
      if (sessionContextInflight.get(sid) === pending) sessionContextInflight.delete(sid);
    });
    sessionContextInflight.set(sid, pending);
  }
  return waitForConsumer(pending, signal);
}

export async function fetchSessionDetails(sid: string, signal: AbortSignal): Promise<SessionDetails> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/details`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const details = await response.json() as Partial<SessionDetails>;
  const version = details.version ?? response.headers.get("X-Session-Version");
  if (!version) throw new Error("服务端会话详情缺少版本");
  return { ...details, version } as SessionDetails;
}

export async function fetchRuntimeState(sid: string, signal: AbortSignal): Promise<AgentRuntimeSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<AgentRuntimeSnapshot>;
}

/** 仅供测试隔离模块级浏览缓存。 */
export function resetSessionContextCacheForTests(): void {
  sessionContextCache.clear();
  sessionContextInflight.clear();
  sessionContextGenerations.clear();
  prefetchQueue.splice(0);
  for (const controller of activePrefetchControllers.values()) controller.abort();
  activePrefetchControllers.clear();
  activePrefetches = 0;
}
