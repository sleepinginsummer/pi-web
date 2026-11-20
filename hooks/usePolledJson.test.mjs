import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sameJson, usePolledJson } = await jiti.import("./usePolledJson.ts");

test("内容相同的轮询快照保持同一个引用", () => {
  const previous = { servers: [{ id: "a", status: "running" }] };
  const identical = { servers: [{ id: "a", status: "running" }] };
  assert.equal(sameJson(previous, previous), true);
  assert.equal(sameJson(previous, identical), true, "结构相同就算没变，下游不用重渲染");
  assert.equal(sameJson(previous, { servers: [{ id: "a", status: "stopped" }] }), false);
  assert.equal(sameJson(null, previous), false);
  assert.equal(sameJson(undefined, undefined), true);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(sameJson(cyclic, cyclic), true, "同一个对象直接命中");
  assert.equal(sameJson(cyclic, {}), false, "没法序列化时保守认为有变化");
});

/**
 * 用真 React + JSDOM 跑一轮轮询：两个项目、三次请求，验证
 * 「换项目后旧项目的结果不覆盖新数据」和「同接口乱序只认最新一次」。
 */
test("换项目后旧请求与旧刷新都不写数据，同接口只认最新一次", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => "visible" });
  const requests = [];
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url) => new Promise((resolve) => {
      requests.push({
        url: String(url),
        respond: (body) => resolve({ ok: true, json: async () => body }),
      });
    }),
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let poll = null;
  const root = createRoot(dom.window.document.getElementById("root"));
  function Fixture({ url }) {
    poll = usePolledJson(url, 60_000);
    return null;
  }
  const render = (url) => act(async () => { root.render(createElement(Fixture, { url })); });

  try {
    await render("/api/tasks?cwd=/a");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/tasks?cwd=/a");
    await act(async () => { requests[0].respond({ items: ["a"] }); });
    assert.deepEqual(poll.data, { items: ["a"] });

    // 项目 A 那次操作收尾时的刷新（act 的 finally 就是它）被留到切项目之后才调用。
    const refreshFromA = poll.refresh;

    await render("/api/tasks?cwd=/b");
    const requestsBeforeSwitchFlush = requests.length;
    assert.equal(poll.data, null, "换项目先清空");
    assert.ok(requestsBeforeSwitchFlush >= 2, "新项目自己会拉一次");
    const bRequest = requests.at(-1);
    assert.equal(bRequest.url, "/api/tasks?cwd=/b");
    await act(async () => { bRequest.respond({ items: ["b"] }); });
    assert.deepEqual(poll.data, { items: ["b"] });

    // A 的旧刷新：不发请求；万一发了，它的结果也不能覆盖 B 的数据。
    const before = requests.length;
    await act(async () => { void refreshFromA(); });
    assert.equal(requests.length, before, "旧项目的刷新不该再发请求");
    if (requests.length > before) await act(async () => { requests[before].respond({ items: ["a-stale"] }); });
    assert.deepEqual(poll.data, { items: ["b"] });

    // 同一接口的两次刷新：先发后到的那次不能覆盖后发的。
    await act(async () => { void poll.refresh(); });
    const firstInFlight = requests.length;
    await act(async () => { void poll.refresh(); });
    const secondInFlight = requests.length;
    assert.equal(secondInFlight, firstInFlight + 1, "两次读数各发一次");
    await act(async () => { requests[secondInFlight - 1].respond({ items: ["b2"] }); });
    assert.deepEqual(poll.data, { items: ["b2"] });
    await act(async () => { requests[firstInFlight - 1].respond({ items: ["b1-stale"] }); });
    assert.deepEqual(poll.data, { items: ["b2"] }, "慢响应晚到时不覆盖新数据");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
