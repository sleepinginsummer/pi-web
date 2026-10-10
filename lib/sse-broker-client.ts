"use client";

/**
 * 页面侧的 SSE broker 客户端。
 *
 * 长连接由同源 SharedWorker 统一持有（每个 URL 一条），页面只订阅事件，
 * 因此"连接数"与窗口数解耦；不支持 SharedWorker 或 worker 建连失败时，
 * 每个订阅各自退回直连 EventSource（即今天的行为），不会因为新机制不可用而丢功能。
 */

/** worker 脚本入口；public/ 下的静态资源，与页面同源。 */
const BROKER_SCRIPT_URL = "/sse-broker.js";

/**
 * 订阅优先级：0 = 会话流/全局 attention（必须有），1 = 文件监听/终端（额度不足可等待）。
 * worker 按此决定谁先占同源额度、以及满额时能否挤掉可暂停的流。
 */
export type StreamPriority = 0 | 1;

export const STREAM_CONNECTING = 0;
export const STREAM_OPEN = 1;
export const STREAM_CLOSED = 2;

/**
 * 与浏览器 EventSource 用法兼容的最小门面：现有代码只依赖
 * onmessage / onerror / addEventListener / removeEventListener / close / readyState。
 */
export interface StreamEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  /** 后接入共享上游时需要自行补一次服务端状态重放（待处理问卷/审批）。 */
  onNeedsReplay?: ((url: string) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

type BrokerMessage =
  | { type: "ping"; url: "" }
  | { type: "paused"; url: string }
  | { type: "attached"; url: string; needsReplay?: boolean }
  | { type: "reserve-granted"; leaseId: string; slots: number }
  | { type: "event"; url: string; name: string | null; data: string }
  | { type: "error"; url: string }
  | { type: "closed"; url: string };

/** 校验 worker 消息，非法负载直接丢弃（跨上下文边界不可信）。 */
export function parseBrokerMessage(value: unknown): BrokerMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  // 端口级协议（ping/pong）不带 url：必须先按 type 分流，否则真实心跳会被整条丢掉，
  // 页面不回 pong，正常的窗口也会被 worker 的租约回收。
  if (message.type === "ping") return { type: "ping", url: "" };
  // 租约回执同样是端口级协议（不带 url），必须在 url 校验之前分流。
  if (message.type === "reserve-granted") {
    return typeof message.leaseId === "string" && typeof message.slots === "number"
      ? { type: "reserve-granted", leaseId: message.leaseId, slots: message.slots }
      : null;
  }
  if (typeof message.url !== "string") return null;
  if (message.type === "paused") return { type: "paused", url: message.url };

  if (message.type === "attached") {
    return { type: "attached", url: message.url, needsReplay: message.needsReplay === true };
  }
  if (message.type === "error" || message.type === "closed") {
    return { type: message.type, url: message.url };
  }
  if (message.type !== "event") return null;
  if (message.name !== null && typeof message.name !== "string") return null;
  if (typeof message.data !== "string") return null;
  return { type: "event", url: message.url, name: message.name, data: message.data };
}

type Subscriber = {
  readonly url: string;
  priority: StreamPriority;
  dispatch(message: BrokerMessage): void;
};

const subscribersByUrl = new Map<string, Set<Subscriber>>();
let worker: SharedWorker | null = null;
let workerUnavailable = false;

function dispatchToUrl(url: string, message: BrokerMessage): void {
  for (const subscriber of [...(subscribersByUrl.get(url) ?? [])]) subscriber.dispatch(message);
}

function handleWorkerFailure(): void {
  if (workerUnavailable) return;
  workerUnavailable = true;
  worker = null;
  // 等待额度的直连租约（终端）也必须有结论：按"没有 broker"的降级策略直接授予，
  // 否则调用方会永远停在等待中（既没有授予也没有失败）。
  for (const lease of [...directLeases.values()]) lease.onGrant(lease.slots);
  directLeases.clear();
  // 让所有订阅退回直连：新机制不可用不等于功能不可用。
  for (const url of [...subscribersByUrl.keys()]) {
    dispatchToUrl(url, { type: "closed", url });
  }
}

function getWorker(): SharedWorker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  if (typeof SharedWorker === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    const created = new SharedWorker(BROKER_SCRIPT_URL);
    created.onerror = () => handleWorkerFailure();
    created.port.onmessage = (event: MessageEvent) => {
      const message = parseBrokerMessage(event.data);
      if (!message) return;
      // worker 靠应答确认窗口还在：关闭的端口会静默吞掉消息，只有回 pong 才算活。
      if (message.type === "reserve-granted") {
        directLeases.get(message.leaseId)?.onGrant(message.slots);
        return;
      }
      if (message.type === "ping") {
        created.port.postMessage({ type: "pong" });
        // 页面被冻结期间 worker 可能已按租约回收本窗口的订阅（冻结时无法回 pong）：
        // 回 pong 的同时重申订阅，恢复投递。
        reassertSubscriptions(created);
        return;
      }
      dispatchToUrl(message.url, message);
    };
    created.port.start?.();
    registerPageLifecycle(created);
    worker = created;
  } catch {
    workerUnavailable = true;
  }
  return worker;
}

let lifecycleRegistered = false;

/**
 * 页面生命周期：离开时告知 worker 释放本窗口独占的上游（刷新/关闭都可能来不及
 * 触发 worker 的失联租约，主动 goodbye 更及时）；从 bfcache 恢复时重新订阅。
 */
function registerPageLifecycle(target: SharedWorker): void {
  if (lifecycleRegistered || typeof window === "undefined") return;
  lifecycleRegistered = true;
  window.addEventListener("pagehide", () => {
    target.port.postMessage({ type: "goodbye" });
  });
  window.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    reassertSubscriptions(target);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reassertSubscriptions(target);
  });
  window.addEventListener("online", () => reassertSubscriptions(target));
}

/** 重申本页面所有订阅（worker 侧幂等）：冻结/离线/恢复后用来重新拿到投递。 */
function reassertSubscriptions(target: SharedWorker): void {
  // 租约回收/pagehide 都会清掉本窗口的直连额度：恢复时连同租约一起重申，
  // 否则恢复后的终端连接不在预算里，broker 上限会高估可用额度。
  for (const lease of directLeases.values()) {
    target.port.postMessage({ type: "reserve-request", leaseId: lease.id, slots: lease.slots });
  }
  for (const [url, subscribers] of subscribersByUrl) {
    const priority = subscribers.values().next().value?.priority ?? 0;
    target.port.postMessage({ type: "subscribe", url, priority });
  }
}

/**
 * 不经 broker 的长连接（终端）的额度租约。
 * 必须先拿到 granted ≥ 需要的数量才建连；额度后续回升时会再次回调。
 */
type DirectLease = {
  readonly id: string;
  readonly slots: number;
  readonly onGrant: (granted: number) => void;
};
const directLeases = new Map<string, DirectLease>();
let leaseSequence = 0;

/**
 * 申请 n 条直连长连接的额度。返回释放函数（幂等）。
 * `onGrant` 会在授予与后续补授时回调实际 granted 数量；少于请求数说明额度不足，
 * 调用方应当等待而不是先把连接建起来。
 */
export function requestDirectStreamSlots(slots: number, onGrant: (granted: number) => void): () => void {
  leaseSequence += 1;
  const id = `lease-${leaseSequence}`;
  const lease: DirectLease = { id, slots: Math.max(0, slots), onGrant };
  const active = getWorker();
  if (!active) {
    // 没有 broker（不支持 SharedWorker）：没有预算可算，直接授予，保持功能可用。
    onGrant(lease.slots);
    return () => {};
  }
  directLeases.set(id, lease);
  active.port.postMessage({ type: "reserve-request", leaseId: id, slots: lease.slots });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    directLeases.delete(id);
    active.port.postMessage({ type: "reserve-release", leaseId: id });
  };
}

/** 仅供测试：隔离 worker、订阅表与生命周期监听。 */
export function resetSseBrokerForTests(): void {
  subscribersByUrl.clear();
  worker = null;
  workerUnavailable = false;
  lifecycleRegistered = false;
  directLeases.clear();
  leaseSequence = 0;
}

function buildStreamSource(url: string, priority: StreamPriority): { source: StreamEventSource; subscribe: () => void; close: () => void } {
  let readyState = STREAM_CONNECTING;
  let closed = false;
  let direct: EventSource | null = null;
  let subscribed = false;
  // 传输所有权：同一时刻只允许一种来源投递事件，避免回退后 broker 与直连各投一份。
  let transport: "broker" | "direct" | "closed" = "broker";
  const namedListeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const messageEvent = (data: string) => new MessageEvent("message", { data });
  const errorEvent = () => new Event("error");

  const openIfNeeded = () => {
    if (readyState === STREAM_CONNECTING) readyState = STREAM_OPEN;
  };

  const source: StreamEventSource = {
    get readyState() {
      return direct ? direct.readyState : readyState;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    addEventListener(type, listener) {
      if (direct) {
        direct.addEventListener(type, listener);
        return;
      }
      const listeners = namedListeners.get(type) ?? new Set();
      listeners.add(listener);
      namedListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      if (direct) {
        direct.removeEventListener(type, listener);
        return;
      }
      namedListeners.get(type)?.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      transport = "closed";
      readyState = STREAM_CLOSED;
      direct?.close();
      direct = null;
      unsubscribeUrl(url, subscriber);
    },
  };

  const subscriber: Subscriber = {
    url,
    priority,
    dispatch(message) {
      if (closed || transport !== "broker") return;
      if (message.type === "attached") {
        const wasConnecting = readyState === STREAM_CONNECTING;
        openIfNeeded();
        if (message.needsReplay) source.onNeedsReplay?.(url);
        if (wasConnecting) {
          const event = new Event("open");
          source.onopen?.(event);
          for (const listener of [...(namedListeners.get("open") ?? [])]) listener(event as unknown as MessageEvent);
        }
        return;
      }
      if (message.type === "event") {
        openIfNeeded();
        const event = messageEvent(message.data);
        if (message.name === null) {
          source.onmessage?.(event);
          for (const listener of [...(namedListeners.get("message") ?? [])]) listener(event);
          return;
        }
        for (const listener of [...(namedListeners.get(message.name) ?? [])]) listener(event);
        return;
      }
      if (message.type === "paused") {
        // 同源额度不足：上游还没建，等额度过会儿自动补发 attached。
        // 这里绝不能退回直连——直连会自己再占一条连接，正好是我们要避免的事。
        readyState = STREAM_CONNECTING;
        return;
      }
      if (message.type === "error") {
        // 上游断开但 worker 会重连：保持 CONNECTING，与 EventSource 的瞬时错误一致。
        readyState = STREAM_CONNECTING;
        source.onerror?.(errorEvent());
        for (const listener of [...(namedListeners.get("error") ?? [])]) listener(messageEvent(""));
        return;
      }
      // 上游被拒绝（404/401）或无法流式读取：退回直连，由调用方按自身策略处理。
      fallbackToDirect();
    },
  };

  function fallbackToDirect(): void {
    if (closed || direct) return;
    // 先退出 broker 订阅，再改用直连：否则同 URL 之后重建 broker 流时，本订阅会收到两份事件。
    transport = "direct";
    unsubscribeUrl(url, subscriber);
    if (typeof EventSource === "undefined") {
      readyState = STREAM_CLOSED;
      source.onerror?.(errorEvent());
      return;
    }
    // 直连是独立连接，服务端会自己重放待处理状态，不需要补。
    source.onNeedsReplay = null;
    direct = new EventSource(url);
    direct.onopen = (event) => source.onopen?.(event);
    // 直连失败不再是"重连中"：与 EventSource 语义一致地进入 CLOSED，由调用方决定是否重试。
    direct.onerror = (event) => {
      source.onerror?.(event);
    };
    direct.onmessage = (event) => source.onmessage?.(event);
    for (const [type, listeners] of namedListeners) {
      for (const listener of [...listeners]) direct.addEventListener(type, listener);
    }
  }

  const subscribe = () => {
    if (closed || subscribed) return;
    subscribed = true;
    const existing = subscribersByUrl.get(url) ?? new Set<Subscriber>();
    existing.add(subscriber);
    subscribersByUrl.set(url, existing);
    const active = getWorker();
    // 已有其他订阅者时上游已经建立：这里仍然发送 subscribe，worker 按 URL 去重。
    if (active) active.port.postMessage({ type: "subscribe", url, priority });
    else fallbackToDirect();
  };

  return { source, subscribe, close: () => source.close() };
}

function unsubscribeUrl(url: string, subscriber: Subscriber): void {
  const subscribers = subscribersByUrl.get(url);
  if (!subscribers) return;
  subscribers.delete(subscriber);
  if (subscribers.size > 0) return;
  subscribersByUrl.delete(url);
  worker?.port.postMessage({ type: "unsubscribe", url });
}

/**
 * 建立一条长连接（经由 broker，必要时直连）。
 * 返回的门面与 EventSource 用法一致，调用方照旧写 onmessage / addEventListener。
 */
export function createStreamSource(url: string, priority: StreamPriority = 0): StreamEventSource {
  const { source, subscribe } = buildStreamSource(url, priority);
  subscribe();
  return source;
}
