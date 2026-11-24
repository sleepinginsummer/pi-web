import {
  AGENT_EVENT_HEARTBEAT_MS,
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import type { DebugEventStream } from "./debug-types";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  isExtensionShutdownRequested?(): boolean;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

export interface AgentEventStreamOptions {
  /** 只用于调试面板标记连接来源，不影响会话存活。 */
  holder?: string | null;
  address?: string | null;
  client?: string | null;
  /** 在事件投影前通知路由侧的持久化缓存失效逻辑。 */
  onEvent?(event: AgentEventLike): void;
}

/**
 * Backpressure for one SSE connection. The client is often a phone: when it
 * stops reading (screen off, backgrounded tab, flaky network) every event we
 * keep enqueueing stays in this process.
 *
 *  - above STREAM_HIGH_WATER_MARK_BYTES we drop events a later event repairs
 *    (streaming deltas, partial tool output);
 *  - above the backlog limit we terminate the stream instead, so the client
 *    reconnects and re-snapshots.
 *
 * Measured before this: a single 24 MB command with a client that stopped
 * reading left 22.7 MB queued here, and that memory only comes back with a GC
 * this app never triggers (issue #923).
 *
 * The limit also has to absorb what a healthy client on a slow link has in
 * flight: one `read` of an image emits its base64 in the tool result's
 * `message_end` (its `message_start` goes as the role only), and that queues
 * up while earlier events are still being written to the socket.
 */
const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
const DEFAULT_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
const BACKPRESSURE_LOG_INTERVAL_MS = 60_000;
let lastBackpressureLogAt = 0;

/**
 * How long `tool_execution_update` events wait to be coalesced. Each update
 * carries the tool's whole partial result, so only the latest one per tool call
 * matters: a codemode script publishes a snapshot of every call it made each
 * time one starts or ends, and bash streams its output tail per chunk. A burst
 * inside the window reaches the client as one event per tool call.
 */
export const TOOL_UPDATE_COALESCE_MS = 150;

/**
 * Whether a later event repairs this one if it is dropped. A `*_delta` only
 * extends a block that its `*_end` replaces with the authoritative content, and
 * `tool_execution_update` carries the whole partial result, which the next update
 * or `tool_execution_end` supersedes, as the next `bash_output` (a command's output
 * tail) or the command's result supersedes one. `*_start` / `*_end` are never dropped: the
 * client's stream reducer creates and finalizes blocks from them.
 */
function isDroppableEvent(event: AgentEventLike): boolean {
  if (event.type === "tool_execution_update" || event.type === "bash_output") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return typeof update === "object"
    && update !== null
    && typeof (update as { type?: unknown }).type === "string"
    && (update as { type: string }).type.endsWith("_delta");
}
function resolveBacklogLimitBytes(): number {
  const raw = Number(process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_BACKLOG_LIMIT_BYTES;
}

function logBackpressure(
  sessionId: string,
  queuedBytes: number,
  limitBytes: number,
  droppedEvents: number,
  closing: boolean,
  stage: "queue" | "preparation" = "queue",
): void {
  const now = Date.now();
  if (now - lastBackpressureLogAt < BACKPRESSURE_LOG_INTERVAL_MS) return;
  lastBackpressureLogAt = now;
  const queued = `${Math.round(queuedBytes / 1024)} KB`;
  const stageNote = stage === "preparation" ? " during initial replay preparation" : "";
  const recovery = stage === "preparation" ? "startup failed before connected; adjust the replay budget before retrying." : "it reconnects and re-snapshots.";
  console.warn(closing
    ? `[pi-web] Agent event stream for ${sessionId} closed${stageNote}: client backlog ${queued} exceeds ${Math.round(limitBytes / 1024)} KB; ${recovery}`
    : `[pi-web] Agent event stream for ${sessionId} is behind${stageNote} (${queued} queued): dropping rebuildable deltas (${droppedEvents} so far).`);
}

/**
 * Registry of live SSE streams, closed from the SIGINT/SIGTERM hook in
 * instrumentation.ts.
 *
 * In production Next 16 handles those signals with `server.close()` and waits
 * for every connection to end, with no timeout and no `closeAllConnections`
 * (that call is dev-only in next/dist/server/lib/start-server.js). An SSE
 * stream only ends when the client disconnects, so without this the process
 * stops listening (502 upstream) but never exits.
 *
 * instrumentation.ts and the route handlers are bundled into separate module
 * graphs, each with its own copy of this module; a plain module-level Set
 * would be two disconnected registries. Symbol.for + globalThis shares one.
 */
const CLOSER_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamClosers");
type StreamCloser = (closeController: boolean | "error") => void;
const activeStreamClosers: Set<StreamCloser> =
  ((globalThis as Record<symbol, Set<StreamCloser>>)[CLOSER_REGISTRY] ??= new Set<StreamCloser>());

/**
 * What the debug panel lists of each live stream, keyed by its closer. A registry of its own:
 * older module copies share the closer Set's shape, and a stream opened before a hot reload of
 * this file is counted there but not listed here.
 */
const STREAM_INFO_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamInfos");
interface AgentEventStreamInfo {
  sessionId: string;
  holder: string | null;
  address: string | null;
  client: string | null;
  openedAt: number;
  connectedAt: number | null;
  lastWriteAt: number | null;
  droppedEvents(): number;
  queuedBytes(): number;
}
const streamInfos: Map<StreamCloser, AgentEventStreamInfo> =
  ((globalThis as Record<symbol, Map<StreamCloser, AgentEventStreamInfo>>)[STREAM_INFO_REGISTRY] ??= new Map());

/** Close every live SSE stream (called on process shutdown signals). */
export function closeAllAgentEventStreams(): void {
  for (const close of [...activeStreamClosers]) {
    try { close("error"); } catch { /* stream already closed */ }
  }
}

/** The live streams, for the debug panel: times and counts, never the request or a payload. */
export function listAgentEventStreams(): (DebugEventStream & { sessionId: string })[] {
  const listed: (DebugEventStream & { sessionId: string })[] = [];
  for (const info of streamInfos.values()) {
    try {
      listed.push({
        sessionId: info.sessionId,
        holder: info.holder,
        address: info.address,
        client: info.client,
        openedAt: info.openedAt,
        connectedAt: info.connectedAt,
        lastWriteAt: info.lastWriteAt,
        droppedEvents: info.droppedEvents(),
        queuedBytes: info.queuedBytes(),
      });
    } catch {
      // An entry another version of this file left behind.
    }
  }
  return listed;
}

/** Every live agent event stream, those opened before a hot reload of this file included. */
export function countAgentEventStreams(): number {
  return activeStreamClosers.size;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 必要回放自身超限时，自动重连不能修复同一份载荷。
class ReplayBudgetExceededError extends Error {}

interface PreparedClientEvent {
  droppable: boolean;
  data: Uint8Array;
  bytes: number;
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 * `meta` (the page's id, the request's reported address and browser label) only labels the
 * stream for the debug panel.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
  options: AgentEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;
      // Latest `tool_execution_update` per tool call id, waiting for the flush.
      const pendingToolUpdates = new Map<unknown, AgentEventLike>();
      let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;

      // "error": hard-terminate the response (SSE client sees a broken
      // stream and reconnects). Used on process shutdown: a plain close() is
      // swallowed by the Next/Node response pipeline without emitting a
      // chunked termination, so the socket stays ESTABLISHED and Next's
      // server.close() drain never completes (the original zombie bug).
      // Also used when a client stops consuming: a graceful close() there
      // would leave the socket (and the queued backlog) alive.
      // "true": graceful close after we finished writing a final event.
      const cleanup = (closeController: boolean | "error", reason?: Error) => {
        if (closed) return;
        closed = true;
        activeStreamClosers.delete(cleanup);
        streamInfos.delete(cleanup);
        if (heartbeat !== null) clearInterval(heartbeat);
        if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
        pendingToolUpdates.clear();
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(reason ?? new Error("pi-web server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      activeStreamClosers.add(cleanup);

      const backlogLimitBytes = resolveBacklogLimitBytes();
      let droppedEvents = 0;
      const info: AgentEventStreamInfo = {
        sessionId,
        holder: options.holder ?? null,
        address: options.address ?? null,
        client: options.client ?? null,
        openedAt: Date.now(),
        connectedAt: null,
        lastWriteAt: null,
        droppedEvents: () => droppedEvents,
        queuedBytes: () => Math.max(0, STREAM_HIGH_WATER_MARK_BYTES - (controller.desiredSize ?? STREAM_HIGH_WATER_MARK_BYTES)),
      };
      streamInfos.set(cleanup, info);
      const enqueuePayload = (payload: string | Uint8Array, options?: { droppable?: boolean }) => {
        if (closed) return;
        const desiredSize = controller.desiredSize;
        if (desiredSize === null) {
          cleanup(false);
          return;
        }
        const queuedBytes = STREAM_HIGH_WATER_MARK_BYTES - desiredSize;
        if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) {
          droppedEvents += 1;
          logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, false);
          return;
        }
        if (queuedBytes > backlogLimitBytes) {
          logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, true);
          cleanup(
            "error",
            new Error(`pi-web agent event stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`),
          );
          return;
        }
        try {
          controller.enqueue(typeof payload === "string" ? encoder.encode(payload) : payload);
          info.lastWriteAt = Date.now();
        } catch {
          cleanup(false);
        }
      };
      const serialize = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      const encode = (data: unknown, options?: { droppable?: boolean }) => {
        enqueuePayload(serialize(data), options);
      };
      const flushToolUpdates = () => {
        toolUpdateTimer = null;
        const updates = [...pendingToolUpdates.values()];
        pendingToolUpdates.clear();
        for (const update of updates) encode(update, { droppable: true });
      };
      const sendClientEvent = (clientEvent: AgentEventLike) => {
        if (clientEvent.type === "tool_execution_update") {
          pendingToolUpdates.set(clientEvent.toolCallId, clientEvent);
          toolUpdateTimer ??= setTimeout(flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
          return;
        }
        // 结束事件清掉尚未刷新的更新，避免稍后又把已结束的工具显示为运行中。
        if (clientEvent.type === "tool_execution_end") {
          pendingToolUpdates.delete(clientEvent.toolCallId);
        } else if (clientEvent.type === "agent_end") {
          pendingToolUpdates.clear();
        }
        encode(clientEvent, { droppable: isDroppableEvent(clientEvent) });
      };
      const projectEvent = (event: AgentEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return null;
        return toClientAgentEvent(event);
      };
      // 初始回放预先编码；实时工具更新仍在合并刷新时序列化，避免高频路径重复处理旧快照。
      const prepareEvent = (clientEvent: AgentEventLike): PreparedClientEvent => {
        const droppable = isDroppableEvent(clientEvent);
        const data = encoder.encode(serialize(clientEvent));
        return { droppable, data, bytes: data.byteLength };
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
        const clientEvent = projectEvent(event, snapshot);
        if (clientEvent) sendClientEvent(clientEvent);
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;
          if (session.isAlive && !session.isAlive() && !session.isExtensionShutdownRequested?.()) {
            cleanup(true);
            return;
          }

          const bufferedEvents: AgentEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike) => {
            if (event.type === "session_ended") {
              encode(event);
              cleanup(true);
              return;
            }
            if (event.type === "session_shutdown") {
              cleanup(true);
              return;
            }
            if (!snapshotPublished) {
              bufferedEvents.push(event);
              return;
            }
            options.onEvent?.(event);
            forwardEvent(event, snapshot);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          if (session.isAlive && !session.isAlive() && !session.isExtensionShutdownRequested?.()) {
            stopListening();
            cleanup(true);
            return;
          }
          unsubscribe = stopListening;

          const snapshot = session.streamingMessage;
          // 初始批次先合并工具更新，结束事件会撤销对应进度；过期副本不进入投影和序列化。
          const latestToolUpdates = new Map<unknown, AgentEventLike>();
          for (const event of bufferedEvents) {
            options.onEvent?.(event);
            if (event.type === "tool_execution_update") latestToolUpdates.set(event.toolCallId, event);
            else if (event.type === "tool_execution_end") latestToolUpdates.delete(event.toolCallId);
            else if (event.type === "agent_end") latestToolUpdates.clear();
          }
          if (closed) return;
          const connectedData = encoder.encode(serialize({
            type: "connected",
            sessionId,
            isStreaming: session.isStreaming,
            pendingExtensionUiIds: bufferedEvents
              .filter((event) => event.type === "extension_ui_request" && typeof event.id === "string")
              .map((event) => event.id as string),
          }));
          // 预留现有队列和全部必要帧，UTF-8 字节预算不能被待发送的序列化文本绕过。
          let retainedBytes = Math.max(0, STREAM_HIGH_WATER_MARK_BYTES - (controller.desiredSize ?? STREAM_HIGH_WATER_MARK_BYTES));
          const reserveRequired = (bytes: number) => {
            const next = retainedBytes + bytes;
            if (next > backlogLimitBytes) {
              logBackpressure(sessionId, next, backlogLimitBytes, droppedEvents, true, "preparation");
              throw new ReplayBudgetExceededError(`initial replay preparation backlog exceeded: ${next} bytes (limit ${backlogLimitBytes})`);
            }
            retainedBytes = next;
          };
          reserveRequired(connectedData.byteLength);
          const replay: Array<PreparedClientEvent | null> = Array(bufferedEvents.length).fill(null);
          const optionalReplay: Array<{ index: number; event: AgentEventLike }> = [];
          for (let index = 0; index < bufferedEvents.length; index++) {
            if (closed) return;
            const event = bufferedEvents[index];
            if (event.type === "tool_execution_update") continue;
            const clientEvent = projectEvent(event, snapshot);
            if (!clientEvent) continue;
            if (isDroppableEvent(clientEvent)) {
              optionalReplay.push({ index, event: clientEvent });
              continue;
            }
            const prepared = prepareEvent(clientEvent);
            reserveRequired(prepared.bytes);
            replay[index] = prepared;
          }
          if (closed) return;
          const snapshotEvent = snapshot !== undefined && snapshot !== null
            ? projectEvent({ type: "message_start", message: snapshot }, undefined) : null;
          const preparedSnapshot = snapshotEvent ? prepareEvent(snapshotEvent) : null;
          if (preparedSnapshot) reserveRequired(preparedSnapshot.bytes);

          let optionalExhausted = false;
          const prepareOptional = (event: AgentEventLike) => {
            if (optionalExhausted || retainedBytes > STREAM_HIGH_WATER_MARK_BYTES || retainedBytes >= backlogLimitBytes) {
              droppedEvents++;
              return null;
            }
            const prepared = prepareEvent(event);
            if (retainedBytes + prepared.bytes > backlogLimitBytes) {
              // 单帧也可能过大；丢弃后不再序列化其余可重建帧，避免逐个大快照重复分配和扫描。
              droppedEvents++;
              optionalExhausted = true;
              return null;
            }
            retainedBytes += prepared.bytes;
            return prepared;
          };
          for (const { index, event } of optionalReplay) {
            if (closed) return;
            replay[index] = prepareOptional(event);
          }
          const preparedToolUpdates: PreparedClientEvent[] = [];
          for (const event of latestToolUpdates.values()) {
            if (closed) return;
            const clientEvent = projectEvent(event, snapshot);
            if (!clientEvent) continue;
            const prepared = prepareOptional(clientEvent);
            if (prepared) preparedToolUpdates.push(prepared);
          }
          if (droppedEvents > 0) logBackpressure(sessionId, retainedBytes, backlogLimitBytes, droppedEvents, false, "preparation");
          if (closed) return;
          // 所有可失败准备均已完成，保持就绪、普通回放、快照、已合并工具进度的线序。
          enqueuePayload(connectedData);
          info.connectedAt = Date.now();
          for (const prepared of replay) if (prepared) enqueuePayload(prepared.data, { droppable: prepared.droppable });
          if (preparedSnapshot) enqueuePayload(preparedSnapshot.data);
          for (const prepared of preparedToolUpdates) enqueuePayload(prepared.data, { droppable: true });
          // 初始批次已合并，直接发送后释放准备引用；不再把准备缓存留进实时更新的延迟队列。
          replay.length = 0;
          preparedToolUpdates.length = 0;
          bufferedEvents.length = 0;
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
            ...(error instanceof ReplayBudgetExceededError ? { code: "sse_replay_budget_exceeded", retryable: false } : {}),
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => encode({ type: "heartbeat" }, { droppable: true }), AGENT_EVENT_HEARTBEAT_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueuePayload(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  }, {
    highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });
}
