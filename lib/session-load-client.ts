import type { AgentRuntimeSnapshot } from "./agent-state";
import type { AgentMessage, SessionTreeNode } from "./types";

export interface SessionContextSnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface SessionDetails {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
}

export type SessionContextResult =
  | { kind: "missing" }
  | { kind: "loaded"; snapshot: SessionContextSnapshot; leafId: string | null };

const SESSION_CONTEXT_CACHE_LIMIT = 50;
const SESSION_CONTEXT_CACHE_TTL_MS = 60_000;
const PREFETCH_CONCURRENCY = 4;
type CachedContext = { promise: Promise<SessionContextResult>; createdAt: number };
const sessionContextCache = new Map<string, CachedContext>();
const prefetchQueue: string[] = [];
const activePrefetchControllers = new Map<string, AbortController>();
let activePrefetches = 0;

function drainPrefetchQueue(): void {
  while (activePrefetches < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const sid = prefetchQueue.shift()!;
    if (sessionContextCache.has(sid) || activePrefetchControllers.has(sid)) continue;
    activePrefetches += 1;
    const controller = new AbortController();
    activePrefetchControllers.set(sid, controller);
    const request = fetchSessionContext(sid, controller.signal, { skipCache: true, messageLimit: SESSION_CONTEXT_CACHE_LIMIT }).catch(() => {
      sessionContextCache.delete(sid);
      return { kind: "missing" } as SessionContextResult;
    }).finally(() => {
      activePrefetchControllers.delete(sid);
      activePrefetches -= 1;
      drainPrefetchQueue();
    });
    sessionContextCache.set(sid, { promise: request, createdAt: Date.now() });
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

/** 列表刷新后删除已经不存在的会话，避免缓存长期持有旧 Promise。 */
export function pruneSessionContextCache(sessionIds: Iterable<string>): void {
  const valid = new Set(sessionIds);
  for (const sid of sessionContextCache.keys()) {
    if (!valid.has(sid)) {
      activePrefetchControllers.get(sid)?.abort();
      sessionContextCache.delete(sid);
    }
  }
  for (let i = prefetchQueue.length - 1; i >= 0; i -= 1) {
    if (!valid.has(prefetchQueue[i])) prefetchQueue.splice(i, 1);
  }
}

/** 会话产生新消息后清除预取快照，并取消尚未完成的预取。 */
export function invalidateSessionContext(sid: string): void {
  activePrefetchControllers.get(sid)?.abort();
  activePrefetchControllers.delete(sid);
  sessionContextCache.delete(sid);
  for (let i = prefetchQueue.length - 1; i >= 0; i -= 1) {
    if (prefetchQueue[i] === sid) prefetchQueue.splice(i, 1);
  }
}



export async function fetchSessionContext(
  sid: string,
  signal: AbortSignal,
  options: { leafId?: string | null; deferThinking?: boolean; deferMedia?: boolean; skipCache?: boolean; messageLimit?: number } = {},
): Promise<SessionContextResult> {
  const params = new URLSearchParams();
  if (options.leafId) params.set("leafId", options.leafId);
  if (options.deferThinking !== false) params.set("deferThinking", "1");
  if (options.deferMedia !== false) params.set("deferMedia", "1");
  if (options.messageLimit) params.set("messageLimit", String(options.messageLimit));
  const cached = !options.leafId && !options.skipCache ? sessionContextCache.get(sid) : undefined;
  if (cached) {
    if (Date.now() - cached.createdAt < SESSION_CONTEXT_CACHE_TTL_MS) return cached.promise;
    sessionContextCache.delete(sid);
  }
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, { signal });
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { context: SessionContextSnapshot; leafId: string | null };
  const entryIds = payload.context.entryIds ?? [];
  if (payload.context.messages.length !== entryIds.length) throw new Error("服务端会话上下文的 messages 与 entryIds 长度不一致");
  return { kind: "loaded", snapshot: { ...payload.context, entryIds }, leafId: payload.leafId };
}

export async function fetchSessionDetails(sid: string, signal: AbortSignal): Promise<SessionDetails> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/details`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<SessionDetails>;
}

export async function fetchRuntimeState(sid: string, signal: AbortSignal): Promise<AgentRuntimeSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<AgentRuntimeSnapshot>;
}
