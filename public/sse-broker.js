/**
 * pi-web 同源 SSE broker（SharedWorker）。
 *
 * 为什么存在：HTTP/1.1 每个源只有 6 条连接，而每个窗口都要"会话流 + 全局 attention 流"
 * 各一条长连接。窗口一多、再开几个文件监听，连接池就被占满，之后所有 API 请求
 * 静默排队（表现为页面"没反应"）。这里把上游连接收敛成"每个 URL 一条"，
 * 窗口只订阅事件，长连接数与窗口数解耦。
 *
 * 协议（页面 <-> worker，均为普通对象）：
 *   页面 -> worker: { type: "subscribe", url, priority? } | { type: "unsubscribe", url }
 *                  | { type: "reserve-request", slots } / { type: "reserve-release", leaseId }
 *                    （终端等直连长连接的额度租约：必须先拿到 granted 才建连）
 *   worker -> 页面: { type: "reserve-granted", leaseId, slots } 授予/追加额度（可能为 0）
 *                  | { type: "pong" } | { type: "goodbye" }
 *   worker -> 页面: { type: "attached", url, needsReplay } 上游已建立（等价于 EventSource 的 open）
 *                  { type: "paused", url }  同源额度不足，暂未建立（不是失败，不要退回直连）
 *                  { type: "event", url, name, data }
 *                  { type: "error", url }   上游断开/重连中（订阅仍然有效）
 *                  { type: "closed", url }  上游被拒绝（404/401）或无法流式读取
 *
 * 语义要点：后接入的订阅者会先收到缓存的"连接就绪"帧（会话流是 data:{"type":"connected"}，
 * 文件监听是 event: connected），因此现有代码里"等到 connected 才认为可用"的门控保持不变。
 */
/* global piWebSseBrokerCore, fetch, AbortController, TextDecoder */
importScripts("./sse-broker-core.js");

const { createSseParser, isConnectedFrame, nextRetryDelay } = piWebSseBrokerCore;

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
/** 端口存活探测间隔；关闭的端口会静默吞掉消息，只能靠应答确认它还活着。 */
const PORT_LEASE_CHECK_MS = 20000;
/**
 * 同源上游总额度。浏览器对同一源只给 6 条连接，这里必须给普通请求留余量，
 * 否则"合并事件流"只是把每窗口 2 条换成"每个 URL 1 条"，仍会占满。
 */
const MAX_UPSTREAMS = 4;
/**
 * 由页面登记的"不经过 broker 的长连接"数量（当前是终端：历史重放按连接做、
 * 且不能暂停，因此保持独立连接）。这些连接同样吃同源额度，必须从 broker 的
 * 上限里扣掉，否则"合并事件流"只合并了一部分，连接池仍会被占满。
 */
/**
 * 终端等"不经 broker 的长连接"的额度租约：leaseId -> { port, slots, requested }。
 * 额度是同一份：上游 + 已授予租约 ≤ MAX_UPSTREAMS，因此终端必须在建连前拿到许可，
 * 拿不到就等待（调用方据此不建连），而不是先连上再说。
 */
/** 租约按端口归属：leaseId 由页面生成（每个窗口都从 lease-1 开始），不能跨窗口共用一张表。 */
const portLeasesById = new Map();

function leaseMap(port) {
  let leases = portLeasesById.get(port);
  if (!leases) {
    leases = new Map();
    portLeasesById.set(port, leases);
  }
  return leases;
}

function findLease(port, leaseId) {
  return portLeasesById.get(port)?.get(leaseId);
}

function allLeases() {
  const leases = [];
  for (const byId of portLeasesById.values()) leases.push(...byId.values());
  return leases;
}
let leaseSequence = 0;

function grantedReservations() {
  let granted = 0;
  for (const lease of allLeases()) granted += lease.slots;
  return granted;
}

/** 长连接的唯一容量入口：上游 + 已授予的直连租约不得超过 MAX_UPSTREAMS（可以为 0）。 */
function availableLongConnectionSlots() {
  return Math.max(0, MAX_UPSTREAMS - upstreams.size - grantedReservations());
}

function notifyLease(lease) {
  post(lease.port, { type: "reserve-granted", leaseId: lease.id, slots: lease.slots });
}

/** 额度变化后把空出来的额度分给等待中的租约，再唤醒等待中的订阅。 */
function regrantLeases() {
  for (const lease of allLeases()) {
    if (lease.slots >= lease.requested) continue;
    const capacity = availableLongConnectionSlots();
    if (capacity <= 0) continue;
    lease.slots += Math.min(capacity, lease.requested - lease.slots);
    notifyLease(lease);
  }
  shrinkToLimit();
  grantPending();
}

/** 上限收紧时让出可暂停的上游（终端租约不能被回收，只能回收低优先级流）。 */
function shrinkToLimit() {
  while (availableLongConnectionSlots() === 0 && upstreams.size > 0 && upstreams.size + grantedReservations() > MAX_UPSTREAMS) {
    const victim = [...upstreams.values()]
      .filter((state) => state.priority > PRIORITY_CRITICAL)
      .sort((left, right) => left.grantedAt - right.grantedAt)[0];
    if (!victim) return;
    pauseUpstream(victim);
  }
}
/** 优先级：0 = 会话流/全局 attention（必须有），1 = 文件监听/终端（可暂停等待）。 */
const PRIORITY_CRITICAL = 0;

/**
 * url -> {
 *   url, subscribers: Set<port>, controller, retryTimer, retryMs,
 *   phase: "connecting" | "open" | "retrying" | "closed",
 *   connectedFrame,
 * }
 * 就绪缓存只在 phase === "open" 时有效：断流与退避期间必须清掉，
 * 否则新订阅者会拿到过期的 attached/connected，以为连接已恢复。
 */
const upstreams = new Map();
/** port -> { awaitingPong }：上一轮 ping 没有应答的端口在下一次巡检时被回收。 */
const portLeases = new Map();
/** 额度满时排队等待的订阅：{ port, url, priority }，额度释放后按优先级授予。 */
const pendingSubscriptions = [];
/**
 * 已附着的订阅注册表：port -> Set<url>。
 * 重申（心跳/可见性恢复/pageshow）必须是幂等的：重复的 subscribe 不新排队、
 * 不重复发 attached（否则会不断触发页面的待处理状态重放）。
 */
const subscriptions = new Map();

function post(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    // 端口已死（窗口崩溃或被关闭）：调用方据此剔除订阅者。
    return false;
  }
}

function eachSubscriber(state, send) {
  for (const port of [...state.subscribers]) {
    if (!post(port, send)) state.subscribers.delete(port);
  }
}

function deliver(state, frame) {
  if (isConnectedFrame(frame)) state.connectedFrame = frame;
  eachSubscriber(state, { type: "event", url: state.url, name: frame.name, data: frame.data });
}

/** 所有权校验：await 之后 state 可能已被暂停/退订替换，旧回调不得再动这个 URL 的状态。 */
function isCurrent(state) {
  return upstreams.get(state.url) === state;
}

function setPhase(state, phase) {
  state.phase = phase;
  // 离开 open 就作废就绪缓存：重连成功前，谁都不算"已连接"。
  if (phase !== "open") state.connectedFrame = null;
}

function dropUpstream(state) {
  // 按实例身份删除：同 URL 可能已经重建了新上游，删错会直接丢掉新连接。
  if (!isCurrent(state)) return;
  setPhase(state, "closed");
  if (state.retryTimer !== null) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.controller?.abort();
  state.controller = null;
  upstreams.delete(state.url);
}

function scheduleRetry(state) {
  if (state.phase === "closed" || state.subscribers.size === 0) {
    if (state.subscribers.size === 0) {
      dropUpstream(state);
      regrantLeases();
    }
    return;
  }
  setPhase(state, "retrying");
  state.retryMs = nextRetryDelay(state.retryMs, RETRY_BASE_MS, RETRY_MAX_MS);
  if (state.retryTimer !== null) clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (!isCurrent(state)) return;
    void connectUpstream(state);
  }, state.retryMs);
}

async function connectUpstream(state) {
  if (state.phase === "closed" || !isCurrent(state)) return;
  setPhase(state, "connecting");
  const controller = new AbortController();
  state.controller = controller;
  try {
    const response = await fetch(state.url, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal: controller.signal,
    });
    // 等待期间可能已被暂停/退订并重建：旧响应的内容不能再投递给任何人。
    if (!isCurrent(state)) {
      controller.abort();
      return;
    }
    if (!response.ok) {
      // 404/401 之类不会因为重连而变好：交给页面按自己的策略重新订阅。
      eachSubscriber(state, { type: "closed", url: state.url });
      dropUpstream(state);
      regrantLeases();
      return;
    }
    const reader = response.body && typeof response.body.getReader === "function"
      ? response.body.getReader()
      : null;
    if (!reader) {
      // 浏览器不支持流式响应（例如较老的 WebKit）：让页面退回各自直连。
      eachSubscriber(state, { type: "closed", url: state.url });
      dropUpstream(state);
      grantPending();
      return;
    }

    state.retryMs = 0;
    setPhase(state, "open");
    // 新连接意味着服务端会再按连接重放一次待处理状态：现有订阅者不需要额外补，
    // 这条连接之后接入的窗口才需要自己请求重放。
    state.replayed = false;
    eachSubscriber(state, { type: "attached", url: state.url, needsReplay: false });
    state.replayed = true;
    const decoder = new TextDecoder();
    const parser = createSseParser((frame) => deliver(state, frame));
    for (;;) {
      const { value, done } = await reader.read();
      if (!isCurrent(state)) {
        controller.abort();
        return;
      }
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    // 服务端正常结束了这条流（例如会话被回收）：通知并重连。
    eachSubscriber(state, { type: "error", url: state.url });
    scheduleRetry(state);
  } catch (error) {
    if (state.phase === "closed" || !isCurrent(state)) return;
    eachSubscriber(state, { type: "error", url: state.url });
    scheduleRetry(state);
  }
}

function grantPending() {
  // 第一遍：已经存在上游的等待项直接附着——它们不需要额度，不能被队首的新 URL 申请挡住。
  for (let index = 0; index < pendingSubscriptions.length;) {
    const entry = pendingSubscriptions[index];
    const state = upstreams.get(entry.url);
    if (!state) {
      index += 1;
      continue;
    }
    pendingSubscriptions.splice(index, 1);
    if (!portLeases.has(entry.port)) continue;
    attachSubscriber(state, entry.port);
  }

  // 第二遍：需要新上游的等待项，按优先级授予，必要时抢占可暂停的上游。
  for (;;) {
    if (pendingSubscriptions.length === 0) return;
    pendingSubscriptions.sort((left, right) => left.priority - right.priority);
    const next = pendingSubscriptions[0];
    if (!portLeases.has(next.port)) {
      pendingSubscriptions.shift();
      continue;
    }
    // 同 URL 的上游可能已由前一个等待者建立：此时只需附着，不再占额度。
    const existing = upstreams.get(next.url);
    if (existing) {
      pendingSubscriptions.shift();
      attachSubscriber(existing, next.port);
      continue;
    }
    if (availableLongConnectionSlots() <= 0) {
      if (next.priority > PRIORITY_CRITICAL) return;
      const victim = [...upstreams.values()]
        .filter((state) => state.priority > PRIORITY_CRITICAL)
        .sort((left, right) => left.grantedAt - right.grantedAt)[0];
      if (!victim) return;
      pauseUpstream(victim);
    }
    pendingSubscriptions.shift();
    attachUpstream(next.port, next.url, next.priority);
  }
}

/** 让出额度：暂停而不是关闭，被暂停的订阅留在队列里（不能把页面推到直连去）。 */
function pauseUpstream(state) {
  for (const subscriber of [...state.subscribers]) {
    subscriptions.get(subscriber)?.delete(state.url);
    if (!pendingSubscriptions.some((entry) => entry.port === subscriber && entry.url === state.url)) {
      pendingSubscriptions.push({ port: subscriber, url: state.url, priority: state.priority });
    }
    post(subscriber, { type: "paused", url: state.url });
  }
  dropUpstream(state);
}

/** 附着到已有上游；只有当前真的 open 才补发就绪，且只补一次。 */
function attachSubscriber(state, port) {
  state.subscribers.add(port);
  const attached = subscriptions.get(port) ?? new Set();
  attached.add(state.url);
  subscriptions.set(port, attached);
  if (state.phase !== "open") return;
  post(port, {
    type: "attached",
    url: state.url,
    // 服务端的待处理状态重放是按连接做的：这条连接已经重放过，之后接入的窗口要自己补。
    needsReplay: state.replayed,
  });
  if (state.connectedFrame) {
    post(port, { type: "event", url: state.url, name: state.connectedFrame.name, data: state.connectedFrame.data });
  }
}

function attachUpstream(port, url, priority) {
  let state = upstreams.get(url);
  if (!state) {
    state = {
      url,
      subscribers: new Set(),
      controller: null,
      retryTimer: null,
      retryMs: 0,
      phase: "connecting",
      connectedFrame: null,
      replayed: false,
      priority,
      grantedAt: Date.now(),
    };
    upstreams.set(url, state);
    void connectUpstream(state);
  }
  attachSubscriber(state, port);
}

function leaseSweep() {
  for (const [port, lease] of [...portLeases]) {
    if (lease.awaitingPong) {
      // 上一轮没有应答：端口已消失（关闭的端口不会报错），回收它占用的上游。
      releasePort(port);
      continue;
    }
    lease.awaitingPong = true;
    post(port, { type: "ping" });
  }
}

setInterval(leaseSweep, PORT_LEASE_CHECK_MS);

function subscribe(port, url, priority) {
  portLeases.set(port, portLeases.get(port) ?? { awaitingPong: false });
  // 幂等：已附着的重申不再排队、不重复发就绪（冻结被回收后 subscriptions 已清理，会重新走流程）。
  if (subscriptions.get(port)?.has(url)) return;
  if (pendingSubscriptions.some((entry) => entry.port === port && entry.url === url)) return;

  const state = upstreams.get(url);
  if (state) {
    attachSubscriber(state, port);
    return;
  }
  pendingSubscriptions.push({ port, url, priority });
  grantPending();
  if (pendingSubscriptions.some((entry) => entry.port === port && entry.url === url)) {
    post(port, { type: "paused", url });
  }
}

function unsubscribe(port, url) {
  for (let index = pendingSubscriptions.length - 1; index >= 0; index -= 1) {
    const entry = pendingSubscriptions[index];
    if (entry.port === port && entry.url === url) pendingSubscriptions.splice(index, 1);
  }
  subscriptions.get(port)?.delete(url);
  const state = upstreams.get(url);
  if (!state) return;
  state.subscribers.delete(port);
  if (state.subscribers.size === 0) {
    dropUpstream(state);
    regrantLeases();
  }
}

function releasePort(port) {
  // 端口退出：先撤销租约与它在队列/注册表里的全部记录，再释放上游。
  // 顺序很重要——若先释放，释放触发的授予会把"已经离开的端口"重新排上额度。
  portLeases.delete(port);
  // 端口退出要归还它的直连租约，否则额度会被历史窗口永久吃掉。
  portLeasesById.delete(port);
  for (let index = pendingSubscriptions.length - 1; index >= 0; index -= 1) {
    if (pendingSubscriptions[index].port === port) pendingSubscriptions.splice(index, 1);
  }
  const attached = subscriptions.get(port);
  subscriptions.delete(port);
  for (const url of attached ?? []) {
    const state = upstreams.get(url);
    if (!state) continue;
    state.subscribers.delete(port);
    if (state.subscribers.size === 0) dropUpstream(state);
  }
  // 释放完毕后统一唤醒等待中的租约与订阅。
  regrantLeases();
}

function handleMessage(port, message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "pong") {
    portLeases.set(port, portLeases.get(port) ?? { awaitingPong: false });
    portLeases.get(port).awaitingPong = false;
    return;
  }
  if (message.type === "reserve-request" && Number.isFinite(message.slots)) {
    leaseSequence += 1;
    const requested = Math.max(0, Math.trunc(message.slots));
    // 页面自带 leaseId：回执必须用同一个 id，否则它认不出这是给谁的授予。
    const leaseId = typeof message.leaseId === "string" && message.leaseId !== "" ? message.leaseId : `lease-${leaseSequence}`;
    const existing = findLease(port, leaseId);
    if (existing) {
      // 重申（心跳/恢复）不能让已经建连的额度归零，只更新请求量并回当前许可。
      existing.requested = requested;
      notifyLease(existing);
      regrantLeases();
      return;
    }
    const lease = { id: leaseId, port, slots: 0, requested };
    leaseMap(port).set(leaseId, lease);
    // 终端不能被暂停：额度不够时让可暂停的上游（文件监听）让路，再按剩余容量授予。
    while (upstreams.size + grantedReservations() + requested > MAX_UPSTREAMS) {
      const victim = [...upstreams.values()]
        .filter((state) => state.priority > PRIORITY_CRITICAL)
        .sort((left, right) => left.grantedAt - right.grantedAt)[0];
      if (!victim) break;
      pauseUpstream(victim);
    }
    const capacity = availableLongConnectionSlots();
    lease.slots = Math.max(0, Math.min(capacity, requested));
    notifyLease(lease);
    grantPending();
    return;
  }
  if (message.type === "reserve-release" && typeof message.leaseId === "string") {
    // 只允许释放本端口自己的租约：leaseId 是页面局部序号，别的窗口可能有同名租约。
    if (portLeasesById.get(port)?.delete(message.leaseId)) regrantLeases();
    return;
  }
  if (message.type === "subscribe" && typeof message.url === "string") {
    subscribe(port, message.url, message.priority === PRIORITY_CRITICAL ? PRIORITY_CRITICAL : 1);
  }
  else if (message.type === "unsubscribe" && typeof message.url === "string") unsubscribe(port, message.url);
  else if (message.type === "goodbye") releasePort(port);
}

// 仅供测试：暴露当前活跃上游数（额度是否生效只能看活跃数，不能用累计请求数代替）。
self.__piWebBrokerActiveUpstreams = () => upstreams.size;
self.__piWebBrokerPending = () => pendingSubscriptions.length;
self.__piWebBrokerSubscriptions = (portIndex) => [...subscriptions.values()][portIndex]?.size ?? 0;
self.__piWebBrokerLimit = () => MAX_UPSTREAMS - grantedReservations();
self.__piWebBrokerLeaseIds = () => allLeases().map((lease) => lease.id);
self.__piWebBrokerReserved = () => grantedReservations();

self.onconnect = (event) => {
  const port = event.ports[0];
  portLeases.set(port, { awaitingPong: false });
  port.onmessage = (messageEvent) => handleMessage(port, messageEvent.data);
  if (typeof port.start === "function") port.start();
};
