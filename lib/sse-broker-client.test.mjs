import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  STREAM_CLOSED,
  STREAM_CONNECTING,
  STREAM_OPEN,
  createStreamSource,
  parseBrokerMessage,
  requestDirectStreamSlots,
  resetSseBrokerForTests,
} = await jiti.import("./sse-broker-client.ts");

/** 假的 SharedWorker：记录页面发出的订阅协议，并可向页面投递消息。 */
function installFakeWorker() {
  const posted = [];
  const instances = [];
  class FakeSharedWorker {
    constructor(url) {
      this.url = url;
      this.port = {
        onmessage: null,
        start() {},
        postMessage: (message) => posted.push(message),
      };
      instances.push(this);
    }
  }
  globalThis.SharedWorker = FakeSharedWorker;
  return {
    posted,
    instances,
    deliver(message) {
      for (const instance of instances) instance.port.onmessage?.({ data: message });
    },
  };
}

function installFakeEventSource() {
  const created = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.listeners = new Map();
      created.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }
    close() { this.readyState = 2; }
  }
  globalThis.EventSource = FakeEventSource;
  return { created };
}

test.beforeEach(() => {
  resetSseBrokerForTests();
  delete globalThis.SharedWorker;
  delete globalThis.EventSource;
});
test.after(() => {
  resetSseBrokerForTests();
  delete globalThis.SharedWorker;
  delete globalThis.EventSource;
});

test("worker 消息校验：非法负载直接丢弃", () => {
  assert.deepEqual(parseBrokerMessage({ type: "attached", url: "/a" }), { type: "attached", url: "/a", needsReplay: false });
  assert.deepEqual(parseBrokerMessage({ type: "paused", url: "/a" }), { type: "paused", url: "/a" });
  // worker 真实发出的 ping 不带 url：它必须能被解析，否则页面不会回 pong 而被租约回收。
  assert.deepEqual(parseBrokerMessage({ type: "ping" }), { type: "ping", url: "" });
  assert.deepEqual(parseBrokerMessage({ type: "event", url: "/a", name: null, data: "x" }), { type: "event", url: "/a", name: null, data: "x" });
  assert.equal(parseBrokerMessage(null), null);
  assert.equal(parseBrokerMessage({ type: "event", url: "/a", data: "x" }), null, "name 缺失即非法");
  assert.equal(parseBrokerMessage({ type: "event", url: "/a", name: "e", data: 5 }), null);
  assert.equal(parseBrokerMessage({ type: "unknown", url: "/a" }), null);
});

test("attached 打开流，命名事件与默认事件分别投递", () => {
  const worker = installFakeWorker();
  const source = createStreamSource("/api/files/x?type=watch");
  assert.equal(source.readyState, STREAM_CONNECTING);
  assert.deepEqual(worker.posted, [{ type: "subscribe", url: "/api/files/x?type=watch", priority: 0 }]);

  let opened = 0;
  const named = [];
  let messages = 0;
  source.onopen = () => { opened += 1; };
  source.addEventListener("change", (event) => named.push(event.data));
  source.onmessage = () => { messages += 1; };

  worker.deliver({ type: "attached", url: "/api/files/x?type=watch" });
  assert.equal(source.readyState, STREAM_OPEN);
  assert.equal(opened, 1);

  worker.deliver({ type: "event", url: "/api/files/x?type=watch", name: "change", data: "1" });
  worker.deliver({ type: "event", url: "/api/files/x?type=watch", name: null, data: "2" });
  assert.deepEqual(named, ["1"], "命名事件只投递给同名监听器");
  assert.equal(messages, 1, "匿名事件走 onmessage");

  // 其他 URL 的事件不得串台
  worker.deliver({ type: "event", url: "/api/agent/other/events", name: null, data: "3" });
  assert.equal(messages, 1);
});

test("同一 URL 的多个订阅共用上游，最后一个退出才退订", () => {
  const worker = installFakeWorker();
  const first = createStreamSource("/api/agent/a/events");
  const second = createStreamSource("/api/agent/a/events");
  assert.equal(worker.posted.filter((m) => m.type === "subscribe").length, 2);

  let seen = 0;
  first.onmessage = () => { seen += 1; };
  second.onmessage = () => { seen += 1; };
  worker.deliver({ type: "event", url: "/api/agent/a/events", name: null, data: "x" });
  assert.equal(seen, 2, "同一事件投递给每个订阅者");

  first.close();
  assert.equal(worker.posted.filter((m) => m.type === "unsubscribe").length, 0, "还有订阅者时不得退订");
  second.close();
  assert.deepEqual(worker.posted.filter((m) => m.type === "unsubscribe"), [{ type: "unsubscribe", url: "/api/agent/a/events" }]);
});

test("worker closed 后退回直连，且旧订阅不再接收 broker 事件（不重复投递）", () => {
  const worker = installFakeWorker();
  const sources = installFakeEventSource();
  const stale = createStreamSource("/api/agent/a/events");
  let staleEvents = 0;
  stale.onmessage = () => { staleEvents += 1; };

  // 上游被拒绝：退回直连，并退出 broker 订阅。
  worker.deliver({ type: "closed", url: "/api/agent/a/events" });
  assert.equal(sources.created.length, 1, "缺少 broker 能力时必须自动直连");
  assert.equal(sources.created[0].url, "/api/agent/a/events");
  assert.deepEqual(worker.posted.filter((m) => m.type === "unsubscribe"), [{ type: "unsubscribe", url: "/api/agent/a/events" }]);

  // 同 URL 的新订阅会重建 broker 流；旧订阅只认直连，不能收到两份。
  const fresh = createStreamSource("/api/agent/a/events");
  let freshEvents = 0;
  fresh.onmessage = () => { freshEvents += 1; };
  worker.deliver({ type: "event", url: "/api/agent/a/events", name: null, data: "x" });
  assert.equal(freshEvents, 1);
  assert.equal(staleEvents, 0, "退回直连的旧订阅不得再接收 broker 事件");

  sources.created[0].onmessage?.({ data: "direct" });
  assert.equal(staleEvents, 1, "直连事件仍然照常投递");
  assert.equal(freshEvents, 1);
});

test("没有 SharedWorker 时直接退回 EventSource", () => {
  const sources = installFakeEventSource();
  const source = createStreamSource("/api/agent/attention/events");
  assert.equal(sources.created.length, 1);
  let messages = 0;
  source.onmessage = () => { messages += 1; };
  sources.created[0].onmessage?.({ data: "x" });
  assert.equal(messages, 1);
});

test("worker 启动失败时所有订阅退回直连", () => {
  const sources = installFakeEventSource();
  installFakeWorker();
  const source = createStreamSource("/api/agent/a/events");
  assert.equal(source.readyState, STREAM_CONNECTING);

  // SharedWorker 全局构造失败（脚本 404、浏览器禁用等）。
  delete globalThis.SharedWorker;
  resetSseBrokerForTests();
  const fresh = createStreamSource("/api/agent/a/events");
  assert.equal(sources.created.length, 1, "退回直连");
  fresh.close();
  assert.equal(fresh.readyState, STREAM_CLOSED);
});

test("paused 不退回直连，needsReplay 通知页面补一次状态", () => {
  const worker = installFakeWorker();
  const sources = installFakeEventSource();
  const source = createStreamSource("/api/files/x?type=watch", 1);
  let replayRequests = 0;
  source.onNeedsReplay = () => { replayRequests += 1; };

  worker.deliver({ type: "paused", url: "/api/files/x?type=watch" });
  assert.equal(sources.created.length, 0, "额度不足不是失败：退回直连会自己再占一条连接");
  assert.equal(source.readyState, STREAM_CONNECTING);

  worker.deliver({ type: "attached", url: "/api/files/x?type=watch", needsReplay: true });
  assert.equal(source.readyState, STREAM_OPEN);
  assert.equal(replayRequests, 1, "后接入共享上游必须补一次待处理问卷/审批");

  worker.deliver({ type: "attached", url: "/api/files/x?type=watch", needsReplay: false });
  assert.equal(replayRequests, 1, "已由连接重放时不得重复请求");
});

test("订阅消息带优先级，冻结恢复时重申订阅", () => {
  const worker = installFakeWorker();
  const listeners = new Map();
  const fakeWindow = {
    addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
  };
  const fakeDocument = {
    visibilityState: "hidden",
    addEventListener: (type, listener) => listeners.set(`document:${type}`, listener),
  };
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  try {
    const source = createStreamSource("/api/files/x?type=watch", 1);
    assert.deepEqual(worker.posted[0], { type: "subscribe", url: "/api/files/x?type=watch", priority: 1 });

    // worker 心跳：回 pong 的同时重申订阅（冻结期间可能已被租约回收）。
    // 用 worker 真实产出的负载形状（不带 url）。
    worker.deliver({ type: "ping" });
    assert.equal(worker.posted.some((m) => m.type === "pong"), true);
    assert.equal(worker.posted.filter((m) => m.type === "subscribe").length, 2, "回 pong 必须重申订阅");

    // 从后台恢复可见时同样重申。
    fakeDocument.visibilityState = "visible";
    listeners.get("document:visibilitychange")?.();
    assert.equal(worker.posted.filter((m) => m.type === "subscribe").length, 3);
    source.close();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("页面恢复时连同直连租约一起重申（冻结回收后预算不能漏算）", () => {
  const worker = installFakeWorker();
  resetSseBrokerForTests();
  const listeners = new Map();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = { addEventListener: (type, listener) => listeners.set(`window:${type}`, listener) };
  globalThis.document = { visibilityState: "hidden", addEventListener: (type, listener) => listeners.set(`document:${type}`, listener) };
  try {
    // 先申请 2 条终端直连额度，再建立订阅（worker 由租约创建）。
    const source = createStreamSource("/api/agent/a/events");
    const releaseLease = requestDirectStreamSlots(2, () => {});
    assert.equal(worker.posted.some((m) => m.type === "reserve-request" && m.slots === 2), true);

    // 冻结被回收后恢复：回 pong 时既要重申订阅，也要重申额度。
    worker.deliver({ type: "ping" });
    const reserveMessages = worker.posted.filter((m) => m.type === "reserve-request");
    assert.equal(reserveMessages.length >= 2, true, "恢复时必须重发租约申请");
    assert.equal(reserveMessages.at(-1).slots, 2);
    releaseLease();
    source.close();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("终端必须先拿到额度才建连；额度为 0 时等待补授", () => {
  const worker = installFakeWorker();
  const grants = [];
  const release = requestDirectStreamSlots(1, (granted) => grants.push(granted));
  assert.equal(grants.length, 0, "申请后必须等 worker 授予");

  // 额度不足：授予 0，调用方不得建连。
  worker.deliver({ type: "reserve-granted", leaseId: "lease-1", slots: 0 });
  assert.deepEqual(grants, [0]);

  // 后续补授：这时才建连。
  worker.deliver({ type: "reserve-granted", leaseId: "lease-1", slots: 1 });
  assert.deepEqual(grants, [0, 1]);

  release();
  assert.equal(worker.posted.some((m) => m.type === "reserve-release"), true, "释放必须归还额度");
});

test("没有 broker 时直接授予额度，功能不因新机制不可用", () => {
  const grants = [];
  const release = requestDirectStreamSlots(1, (granted) => grants.push(granted));
  assert.deepEqual(grants, [1]);
  release();
});

test("worker 异步失败时，等待额度的终端不会被永久挂住", () => {
  const worker = installFakeWorker();
  const grants = [];
  requestDirectStreamSlots(1, (granted) => grants.push(granted));
  assert.deepEqual(grants, [], "申请后先等授予");

  // 脚本加载失败/worker 崩掉：租约必须按降级策略给出结论，而不是永远等待。
  worker.instances[0].onerror?.(new Event("error"));
  assert.deepEqual(grants, [1], "worker 失败后等待中的租约必须被授予（降级继续可用）");

  // 之后的新申请同样立即授予：此时已经没有 broker 可算预算。
  const later = [];
  requestDirectStreamSlots(1, (granted) => later.push(granted));
  assert.deepEqual(later, [1]);
});
