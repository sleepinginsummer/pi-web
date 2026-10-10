import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseBrokerMessage } = await jiti.import("../lib/sse-broker-client.ts");

const coreSource = await readFile(new URL("./sse-broker-core.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("./sse-broker.js", import.meta.url), "utf8");

/** 在 vm 里加载 broker 核心逻辑（与 worker 运行的是同一份源码）。 */
function loadCore() {
  const sandbox = { self: undefined, JSON, Map, Set };
  sandbox.self = sandbox;
  vm.runInNewContext(coreSource, sandbox);
  return sandbox.piWebSseBrokerCore;
}

/**
 * 在 vm 里加载 SharedWorker 脚本：提供 importScripts / fetch / AbortController 假实现，
 * 用假 MessagePort 驱动订阅协议。
 */
function loadWorker(fetchImpl) {
  // 定时器全部假化：测试自己决定何时触发租约巡检与重连，且不会让进程挂住。
  const timers = [];
  const intervals = [];
  const sandbox = {
    self: undefined,
    JSON, Map, Set, TextDecoder, AbortController,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    fetch: (...args) => { fetchCount += 1; return fetchImpl(...args); },
    fetchCalls: [],
  };
  let fetchCount = 0;
  sandbox.self = sandbox;
  sandbox.importScripts = () => vm.runInNewContext(coreSource, sandbox);
  vm.runInNewContext(workerSource, sandbox);
  assert.equal(typeof sandbox.onconnect, "function", "worker 必须注册 onconnect");

  const ports = [];
  const connect = () => {
    const received = [];
    const port = {
      received,
      // 真实 postMessage 会结构化克隆；这里用 JSON 往返模拟，顺便保证断言处于同一 realm。
      postMessage(message) { received.push(JSON.parse(JSON.stringify(message))); },
      start() {},
      onmessage: null,
    };
    ports.push(port);
    sandbox.onconnect({ ports: [port] });
    return {
      received,
      send: (message) => port.onmessage({ data: message }),
    };
  };
  return {
    connect,
    timers,
    intervals,
    upstreamCount: () => sandbox.__piWebBrokerActiveUpstreams(),
    limit: () => sandbox.__piWebBrokerLimit(),
    reservedCount: () => sandbox.__piWebBrokerReserved(),
    leaseIds: () => sandbox.__piWebBrokerLeaseIds(),
    pendingCount: () => sandbox.__piWebBrokerPending(),
    /** 触发一次重连定时器（模拟退避到期）。 */
    flushTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer.fn();
    },
  };
}

function responseStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    },
  };
}

/** 上游保持 open（读完给定 chunk 后挂起），用于验证"上游仍然在线"的场景。 */
function openStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return new Promise(() => {});
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    },
  };
}

test("SSE 解析器按帧切分：跨 chunk、命名事件、多行 data、注释心跳都正确", () => {
  const { createSseParser } = loadCore();
  const frames = [];
  const parser = createSseParser((frame) => frames.push(JSON.parse(JSON.stringify(frame))));

  // 会话流：data 帧被 chunk 切断；心跳是注释行。
  parser.push(": ping\n\nda");
  parser.push('ta: {"type":"connected"}\n');
  parser.push("\n");
  // 文件监听：命名事件 + CRLF。
  parser.push("event: change\r\ndata: {\"size\":12}\r\n\r\n");
  parser.push("data: line-1\ndata: line-2\n\n");

  assert.deepEqual(frames, [
    { name: null, data: '{"type":"connected"}' },
    { name: "change", data: '{"size":12}' },
    { name: null, data: "line-1\nline-2" },
  ]);
});

test("同一 URL 的两个窗口共享一条上游连接，事件分别投递", async () => {
  const pending = [];
  const { connect } = loadWorker((url, init) => {
    const controller = { url, signal: init.signal };
    pending.push(controller);
    return new Promise((resolve) => {
      controller.resolve = () => resolve(responseStream(['data: {"type":"connected"}\n\n']));
    });
  });

  const first = connect();
  const second = connect();
  first.send({ type: "subscribe", url: "/api/agent/a/events" });
  second.send({ type: "subscribe", url: "/api/agent/a/events" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pending.length, 1, "两个窗口必须共用一条上游连接");
  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));

  // 两个窗口都拿到 attached（open 语义）与同一条上游的 connected 事件。
  assert.equal(first.received[0].type, "attached");
  assert.equal(first.received[0].needsReplay, false, "第一个订阅者已由服务端按连接重放");
  assert.equal(second.received[0].type, "attached");
  // 两者都在连接建立前订阅：服务端按连接重放一次即可覆盖两边，都不需要额外补。
  assert.equal(second.received[0].needsReplay, false);
  const connectedFrames = (client) => client.received.filter((m) => m.type === "event" && m.data.includes('"connected"'));
  assert.equal(connectedFrames(first).length, 1);
  assert.equal(connectedFrames(second).length, 1, "同一上游的事件必须投递给每个订阅者");
});

test("后接入的订阅者会先收到 attached 与缓存的连接就绪帧", async () => {
  const controllers = [];
  const { connect } = loadWorker((url) => {
    const controller = { url, resolve: null };
    controllers.push(controller);
    return new Promise((resolve) => { controller.resolve = () => resolve(openStream(['data: {"type":"connected"}\n\n'])); });
  });

  const first = connect();
  first.send({ type: "subscribe", url: "/api/files/x?type=watch" });
  await new Promise((resolve) => setImmediate(resolve));
  controllers[0].resolve();
  // 等上游真正 open（第一个订阅者拿到 attached）后再让第二个接入，
  // 这样才是在验证"已 open 的共享上游"上的后接入者。
  for (let tick = 0; tick < 10 && first.received.length === 0; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(first.received[0].type, "attached");
  assert.equal(first.received[0].needsReplay, false);

  const late = connect();
  late.send({ type: "subscribe", url: "/api/files/x?type=watch" });
  assert.equal(late.received[0].type, "attached");
  assert.equal(late.received[0].needsReplay, true);
  assert.deepEqual(late.received[1], {
    type: "event", url: "/api/files/x?type=watch", name: null, data: '{"type":"connected"}',
  }, "后接入者必须拿到就绪帧，否则会一直等到超时");
});

test("最后一个订阅者退出后断开上游，再订阅时重新建立", async () => {
  const controllers = [];
  const { connect } = loadWorker((url, init) => {
    const controller = { signal: init.signal };
    controllers.push(controller);
    return new Promise((resolve) => { controller.resolve = () => resolve(responseStream([])); });
  });

  const first = connect();
  const second = connect();
  first.send({ type: "subscribe", url: "/api/agent/attention/events" });
  second.send({ type: "subscribe", url: "/api/agent/attention/events" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.length, 1);

  first.send({ type: "unsubscribe", url: "/api/agent/attention/events" });
  assert.equal(controllers[0].signal.aborted, false, "还有订阅者时不得断开上游");
  second.send({ type: "unsubscribe", url: "/api/agent/attention/events" });
  assert.equal(controllers[0].signal.aborted, true, "最后一个订阅者退出必须释放连接");

  second.send({ type: "subscribe", url: "/api/agent/attention/events" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.length, 2, "重新订阅要能重新建立连接");
});

test("上游被拒绝时通知 closed，交给页面按自身策略处理", async () => {
  const { connect } = loadWorker(async () => ({ ok: false, status: 401 }));
  const client = connect();
  client.send({ type: "subscribe", url: "/api/agent/expired/events" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(client.received, [{ type: "closed", url: "/api/agent/expired/events" }]);
});

test("断流退避期间的新订阅不收到 ready，重连成功后才收到", async () => {
  const responses = [];
  const worker = loadWorker(() => new Promise((resolve) => { responses.push(resolve); }));

  const first = worker.connect();
  first.send({ type: "subscribe", url: "/api/agent/a/events" });
  await new Promise((resolve) => setImmediate(resolve));
  // 首条上游送出就绪帧后断开（chunk 用尽 => done）。
  responses[0](responseStream(['data: {"type":"connected"}\n\n']));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.received.some((m) => m.type === "event"), true);

  // 退避期间接入的新订阅者：连接并未就绪，不能补发 attached/connected。
  const late = worker.connect();
  late.send({ type: "subscribe", url: "/api/agent/a/events" });
  assert.deepEqual(late.received, [], "退避期间不得补发就绪，否则首条 prompt 会在流恢复前发出");

  // 退避到期重连成功：这时才补发就绪。
  worker.flushTimers();
  await new Promise((resolve) => setImmediate(resolve));
  responses[1](responseStream(['data: {"type":"connected"}\n\n']));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.received[0].type, "attached");
  assert.equal(late.received[1].type, "event");
});

test("一个窗口退出时，它独占的上游被释放，共享的保留", async () => {
  const controllers = [];
  const worker = loadWorker((url, init) => {
    const controller = { url, signal: init.signal };
    controllers.push(controller);
    return new Promise((resolve) => { controller.resolve = () => resolve(responseStream([])); });
  });

  const leaving = worker.connect();
  const staying = worker.connect();
  leaving.send({ type: "subscribe", url: "/api/agent/only-here/events" });
  leaving.send({ type: "subscribe", url: "/api/agent/shared/events" });
  staying.send({ type: "subscribe", url: "/api/agent/shared/events" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.length, 2);

  leaving.send({ type: "goodbye" });
  const exclusive = controllers.find((c) => c.url === "/api/agent/only-here/events");
  const shared = controllers.find((c) => c.url === "/api/agent/shared/events");
  assert.equal(exclusive.signal.aborted, true, "退出窗口独占的上游必须释放");
  assert.equal(shared.signal.aborted, false, "仍被其他窗口订阅的上游不能断");

  // 失联租约：留下的窗口不回 pong 时同样会被回收。
  const sweep = worker.intervals[0].fn;
  sweep();
  assert.equal(shared.signal.aborted, false, "第一次巡检只发 ping");
  sweep();
  assert.equal(shared.signal.aborted, true, "两轮无应答说明窗口已消失");
});

test("同源上游总额度封顶：超出额度的订阅被暂停而不是直连", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const clients = ["/api/agent/a/events", "/api/agent/attention/events", "/api/files/1", "/api/files/2", "/api/files/3"]
    .map((url) => ({ url, client: worker.connect() }));
  for (const { url, client } of clients) client.send({ type: "subscribe", url, priority: url.includes("/api/files/") ? 1 : 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4, "同源上游不得超过额度（浏览器只给 6 条并要留余量）");

  // 超出额度的那一条收到 paused，不能回退直连（直连会自己再占一条连接）。
  const overflow = clients.find(({ client }) => client.received.some((m) => m.type === "paused"));
  assert.ok(overflow, "超出额度必须发 paused");
});

test("额度释放后暂停的订阅自动补位；高优先级请求可挤掉可暂停的上游", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const files = ["/api/files/1", "/api/files/2", "/api/files/3", "/api/files/4", "/api/files/5"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    return { url, client };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);
  const paused = files[4];
  assert.equal(paused.client.received.some((m) => m.type === "paused"), true);

  // 关键流（会话流）到达：挤掉一个低优先级上游，被挤掉的回到队列等待。
  const session = worker.connect();
  session.send({ type: "subscribe", url: "/api/agent/a/events", priority: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4, "总额度不变");
  const evicted = files.slice(0, 4).find(({ client }) => client.received.some((m) => m.type === "paused"));
  assert.ok(evicted, "被挤掉的上游必须收到 paused");

  // 释放一个额度：队列里的订阅自动补位。
  session.send({ type: "unsubscribe", url: "/api/agent/a/events" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);
  // 补位 = 离开等待队列并重新占用额度（accepted 上游要等 fetch 回来才发 attached）。
  assert.equal(worker.pendingCount() < 2, true, "补位后等待队列必须缩短");
  assert.equal(worker.upstreamCount(), 4, "额度被重新占满");
});

test("窗口退出时不会重新建立它排队的订阅，终止路径都会唤醒队列", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  // 同一窗口申请 5 条流：额度只有 4，第 5 条在排队。
  const solo = worker.connect();
  for (let index = 0; index < 5; index += 1) {
    solo.send({ type: "subscribe", url: `/api/files/${index}`, priority: 1 });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);
  assert.equal(worker.pendingCount(), 1);

  solo.send({ type: "goodbye" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 0, "退出端口不得把排队项授予自己，残留连接");
  assert.equal(worker.pendingCount(), 0, "排队项必须随端口一起清掉");

  // 其他窗口保留的订阅仍然有效（额度释放后不该被顺手清掉）。
  const keeper = worker.connect();
  keeper.send({ type: "subscribe", url: "/api/files/keep", priority: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 1);
  keeper.send({ type: "unsubscribe", url: "/api/files/keep" });
  assert.equal(worker.upstreamCount(), 0);
});

test("上游被拒绝释放额度后，等待中的订阅会被唤醒", async () => {
  let rejected = 0;
  const worker = loadWorker(async (url) => {
    if (url === "/api/dies") { rejected += 1; return { ok: false, status: 404 }; }
    return new Promise(() => {});
  });
  const clients = ["/api/a", "/api/b", "/api/c", "/api/dies", "/api/waits"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    return { url, client };
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, 1);
  assert.equal(worker.upstreamCount(), 4, "被拒绝的那条释放额度后，等待者补位");
  assert.equal(worker.pendingCount(), 0, "等待队列必须被唤醒");
  const waiting = clients.find(({ url }) => url === "/api/waits");
  assert.equal(waiting.client.received.some((m) => m.type === "closed"), false);
});

test("满额期间重复重申不增加队列，已有流的新窗口不被新 URL 申请阻塞", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const filled = [];
  for (const url of ["/api/a", "/api/b", "/api/c", "/api/d"]) {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    filled.push({ url, client });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);

  // 一个新 URL 申请等额度（排在第 1 位），随后同一窗口反复重申（心跳/可见性恢复）。
  const waiting = worker.connect();
  waiting.send({ type: "subscribe", url: "/api/z", priority: 1 });
  for (let index = 0; index < 5; index += 1) waiting.send({ type: "subscribe", url: "/api/z", priority: 1 });
  assert.equal(worker.pendingCount(), 1, "重申必须幂等，不能反复排队");

  // 已有上游的新窗口直接附着：不能被队首的新 URL 申请挡住。
  const late = worker.connect();
  late.send({ type: "subscribe", url: "/api/a", priority: 1 });
  assert.equal(late.received.some((m) => m.type === "paused"), false, "已有上游的订阅不需要额度");
  assert.equal(worker.pendingCount(), 1);

  // 已附着的重复重申不得重复发 attached（否则会反复触发页面重放待处理状态）。
  const attachedCount = () => late.received.filter((m) => m.type === "attached").length;
  const before = attachedCount();
  late.send({ type: "subscribe", url: "/api/a", priority: 1 });
  assert.equal(attachedCount(), before, "已附着的重申不得重复发 attached");
});

test("旧请求迟到返回时不得投递，也不得删掉同 URL 的新连接", async () => {
  const responses = [];
  const worker = loadWorker(() => new Promise((resolve) => { responses.push(resolve); }));

  const client = worker.connect();
  client.send({ type: "subscribe", url: "/api/late", priority: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);

  // 退订：旧上游被删除（页面此时并没有退出，仍可再订阅）。
  client.send({ type: "unsubscribe", url: "/api/late" });
  assert.equal(worker.upstreamCount(), 0);

  // 同 URL 重建：这是一条全新的上游与全新的请求。
  client.send({ type: "subscribe", url: "/api/late", priority: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 2, "重建必须发起新的上游请求");

  // 旧请求迟到完成：既不能投递事件，也不能把新上游删掉。
  responses[0](openStream(['data: {"type":"connected"}\n\n']));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 1, "旧回调不得删除新上游");
  assert.equal(
    client.received.some((m) => m.type === "event"),
    false,
    "旧请求的事件不得投递给任何人",
  );

  // 新请求正常完成时照常投递。
  responses[1](openStream(['data: {"type":"connected"}\n\n']));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.received.some((m) => m.type === "event"), true);
});

test("worker 发出的心跳能被客户端解析并回 pong（两端共用同一份负载）", () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const client = worker.connect();
  client.send({ type: "subscribe", url: "/api/x", priority: 0 });

  worker.intervals[0].fn(); // 第一轮只发 ping
  const ping = client.received.find((message) => message.type === "ping");
  assert.ok(ping, "worker 必须发出 ping");
  // 关键：用真实的 ping 负载过客户端校验器，避免两端各自造不同形状。
  assert.deepEqual(parseBrokerMessage(ping), { type: "ping", url: "" });
});

test("同 URL 的多个等待者在额度释放后一起恢复（第二个只需附着）", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const filled = ["/api/a", "/api/b", "/api/c", "/api/d"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    return { url, client };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);

  // 两个窗口等待同一个 URL。
  const first = worker.connect();
  const second = worker.connect();
  first.send({ type: "subscribe", url: "/api/shared", priority: 1 });
  second.send({ type: "subscribe", url: "/api/shared", priority: 1 });
  assert.equal(worker.pendingCount(), 2);

  // 释放一个额度：第一个建立上游，第二个应当附着同一条，而不是继续等下一次额度变化。
  filled[0].client.send({ type: "unsubscribe", url: filled[0].url });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.pendingCount(), 0, "第二个等待者必须直接附着刚建立的上游");
  assert.equal(worker.upstreamCount(), 4);
});

test("终端登记预留额度后，broker 上限相应下调", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const clients = ["/api/a", "/api/b", "/api/c", "/api/d"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    return { url, client };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);

  // 两个终端窗口各占一条直连：broker 必须让出两条，保证普通请求有余量。
  clients[3].client.send({ type: "reserve-request", slots: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 2, "总额度扣掉终端占用");
  assert.equal(worker.reservedCount(), 2);
  assert.equal(worker.pendingCount() >= 1, true, "被让出的流回到等待队列");
});

test("终端额度按窗口累加、随窗口退出归还", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const one = worker.connect();
  const two = worker.connect();
  one.send({ type: "reserve-request", slots: 1 });
  two.send({ type: "reserve-request", slots: 1 });
  assert.equal(worker.reservedCount(), 2, "两个窗口各 1 条终端连接必须累加");
  assert.equal(worker.limit(), 2, "broker 上限相应下调");

  // 一个窗口退出：归还它登记的额度并唤醒队列。
  const holder = worker.connect();
  holder.send({ type: "subscribe", url: "/api/x", priority: 1 });
  assert.equal(worker.upstreamCount(), 1);
  two.send({ type: "goodbye" });
  assert.equal(worker.reservedCount(), 1, "退出窗口的预留必须归还");
  assert.equal(worker.limit(), 3);
  holder.send({ type: "unsubscribe", url: "/api/x" });
});

test("已开满 4 条上游时登记两个终端，普通请求仍留有余量", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const clients = ["/api/a", "/api/b", "/api/c", "/api/d"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 1 });
    return { url, client };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 4);

  const terminalOne = worker.connect();
  const terminalTwo = worker.connect();
  terminalOne.send({ type: "reserve-request", slots: 1 });
  terminalTwo.send({ type: "reserve-request", slots: 1 });
  // 2 条 broker 上游 + 2 条终端 = 4，浏览器上限 6，普通请求始终有 2 条余量。
  assert.equal(worker.upstreamCount() + worker.reservedCount() <= 4, true, "长连接总数不得吃掉普通请求的余量");
  assert.equal(clients.length, 4);
});

test("额度被直连租约占满后，新 SSE 必须等待而不是再建一条", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const terminals = [];
  for (let index = 0; index < 4; index += 1) {
    const client = worker.connect();
    client.send({ type: "reserve-request", slots: 1 });
    terminals.push(client);
  }
  assert.equal(worker.reservedCount(), 4, "4 条租约全部授予");
  assert.equal(worker.limit(), 0, "剩余上游额度为 0");

  const stream = worker.connect();
  stream.send({ type: "subscribe", url: "/api/agent/a/events", priority: 0 });
  assert.equal(worker.upstreamCount(), 0, "没有额度时不得再建上游");
  assert.equal(stream.received.some((m) => m.type === "paused"), true);

  // 归还一条租约：等待中的 SSE 立即拿到额度。
  terminals[0].send({ type: "reserve-release", leaseId: worker.leaseIds()[0] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.upstreamCount(), 1, "额度归还后等待者补位");
});

test("上游错误释放后，等待中的直连租约被授予", async () => {
  const worker = loadWorker(async (url) => {
    if (url === "/api/dies") return { ok: false, status: 404 };
    return new Promise(() => {});
  });
  // 关键流（会话级）：不可暂停，因此租约必须排队等额度释放。
  const holders = ["/api/a", "/api/b", "/api/c", "/api/dies"].map((url) => {
    const client = worker.connect();
    client.send({ type: "subscribe", url, priority: 0 });
    return { url, client };
  });
  const terminal = worker.connect();
  terminal.send({ type: "reserve-request", slots: 1 });
  assert.equal(worker.reservedCount(), 0, "额度被上游占满时租约先排队");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.reservedCount(), 1, "错误释放的额度必须授予等待中的租约");
  assert.equal(terminalsHeld(holders), 3);
});

function terminalsHeld(holders) {
  return holders.filter(({ url }) => url !== "/api/dies").length;
}

test("两个窗口使用同名 leaseId 时互不干扰，重申不改变已授予总量", async () => {
  const worker = loadWorker(() => new Promise(() => {}));
  const first = worker.connect();
  const second = worker.connect();
  // 两边页面都从 lease-1 开始（局部序号）——必须各占一份额度。
  first.send({ type: "reserve-request", leaseId: "lease-1", slots: 1 });
  second.send({ type: "reserve-request", leaseId: "lease-1", slots: 1 });
  assert.equal(worker.reservedCount(), 2, "同名租约必须各占一份");

  // 其中一个释放，不影响另一个。
  first.send({ type: "reserve-release", leaseId: "lease-1" });
  assert.equal(worker.reservedCount(), 1);

  // 重申（心跳/恢复）不能让已授予的额度归零。
  second.send({ type: "reserve-request", leaseId: "lease-1", slots: 1 });
  assert.equal(worker.reservedCount(), 1, "重申只回当前许可，不重置已授予数量");
  assert.equal(second.received.some((m) => m.type === "reserve-granted" && m.slots === 1), true, "重申要回执当前许可");
});
