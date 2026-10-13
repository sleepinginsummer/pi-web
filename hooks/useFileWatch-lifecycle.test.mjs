import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useFileWatch, fileWatchBudget } = await jiti.import("./useFileWatch.ts");
const { resetSseBrokerForTests } = await jiti.import("../lib/sse-broker-client.ts");

test("监听重连保留未变文件的预览版本，隐藏期间修改、实时修改和删除仍使预览失效", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const streams = [];
  class FileStream extends EventTarget {
    constructor() { super(); this.closed = false; streams.push(this); }
    close() { this.closed = true; }
  }
  let metadata = { size: 12, version: "original" };
  let snapshot;
  let resets = 0;
  const reset = () => { resets += 1; };
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    EventSource: FileStream,
    SharedWorker: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => {
      const captured = { ...metadata };
      return { json: async () => captured };
    },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  function Fixture({ enabled }) {
    snapshot = useFileWatch({ filePath: "/project/preview.html", enabled, onReset: reset });
    return null;
  }
  const render = enabled => act(async () => { root.render(createElement(Fixture, { enabled })); });
  const connected = () => act(async () => { streams.at(-1).dispatchEvent(new Event("connected")); });
  const changed = data => act(async () => {
    streams.at(-1).dispatchEvent(new MessageEvent("change", { data: JSON.stringify(data) }));
  });
  try {
    await render(true);
    await connected();
    const initialBust = snapshot.bust;
    const initialResets = resets;
    await render(false);
    assert.equal(streams.at(-1).closed, true);
    await render(true);
    await connected();
    assert.equal(snapshot.bust, initialBust, "文件未变，重连不能刷新预览 URL");
    assert.equal(resets, initialResets, "文件未变，重连不能清除媒体或表单状态");

    await render(false);
    metadata = { size: 12, version: "edited-while-hidden" };
    await render(true);
    await connected();
    assert.equal(snapshot.bust, initialBust + 1, "同大小编辑也必须在重连时被发现");
    await changed(metadata);
    assert.equal(snapshot.bust, initialBust + 1, "元数据与监听事件观察到同一版本时只刷新一次");
    await changed({ size: 12, version: "live-edit" });
    assert.equal(snapshot.bust, initialBust + 2);
    await changed({ size: 0, version: null });
    assert.equal(snapshot.bust, initialBust + 3, "删除文件必须使旧预览失效");
    await changed({ size: 12, version: "recreated" });
    assert.equal(snapshot.bust, initialBust + 4);

    await render(false);
    metadata = { error: "Not found" };
    await render(true);
    await connected();
    assert.equal(snapshot.bust, initialBust + 5, "隐藏期间删除也必须清除旧预览");
    assert.equal(snapshot.error, "Not found");
    await connected();
    assert.equal(snapshot.bust, initialBust + 5, "重复的不可读快照不应反复重载");
    metadata = { size: 12, version: "restored-after-hidden-delete" };
    await connected();
    assert.equal(snapshot.bust, initialBust + 6);
    assert.equal(snapshot.error, null);
  } finally {
    await act(async () => { root.unmount(); });
    assert.equal(fileWatchBudget.size, 0);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("共享上游的重新挂接也会检查暂停期间的文件版本", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  class BrokerWorker {
    constructor() {
      this.port = {
        start() {},
        postMessage: message => {
          if (message.type !== "subscribe") return;
          queueMicrotask(() => this.port.onmessage({
            data: { type: "attached", url: message.url, needsReplay: true },
          }));
        },
      };
    }
  }
  let metadata = { size: 12, version: "before-pause" };
  let snapshot;
  const replacements = {
    window: dom.window, document: dom.window.document, SharedWorker: BrokerWorker,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => ({ json: async () => ({ ...metadata }) }),
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  resetSseBrokerForTests();
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  function Fixture({ enabled }) {
    snapshot = useFileWatch({ filePath: "/project/shared.html", enabled });
    return null;
  }
  const render = enabled => act(async () => { root.render(createElement(Fixture, { enabled })); });
  try {
    await render(true);
    const initialBust = snapshot.bust;
    await render(false);
    await render(true);
    assert.equal(snapshot.bust, initialBust);
    await render(false);
    metadata = { size: 12, version: "changed-during-pause" };
    await render(true);
    assert.equal(snapshot.bust, initialBust + 1);
  } finally {
    await act(async () => { root.unmount(); });
    resetSseBrokerForTests();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
