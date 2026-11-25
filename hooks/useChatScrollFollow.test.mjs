import assert from "node:assert/strict";
import test from "node:test";
import React, { useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useChatScrollFollow } = await jiti.import("./useChatScrollFollow.ts");

test("恢复阅读点后忽略首次默认滚到底部，但后续分支定位仍生效", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const frames = new Map();
  let nextFrame = 0;
  const globals = {
    window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.querySelector("#root"));
  const scrolls = [];
  function Subject({ request, restoring }) {
    const { scrollContainerRef } = useChatScrollFollow({
      agentRunning: false, isStreaming: false, loading: false,
      messageCount: 1, positionRequest: request, deferInitialScroll: restoring,
    });
    useLayoutEffect(() => {
      const element = scrollContainerRef.current;
      Object.defineProperties(element, {
        scrollHeight: { configurable: true, value: 2000 },
        clientHeight: { configurable: true, value: 500 },
      });
      element.scrollTop = 700;
      element.scrollTo = (options) => { scrolls.push(options.top); element.scrollTop = options.top; };
    }, [scrollContainerRef]);
    return React.createElement("div", { ref: scrollContainerRef });
  }
  t.after(async () => {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  const render = async (request, restoring) => React.act(() => root.render(React.createElement(Subject, { request, restoring })));
  const flushFrames = async () => React.act(() => {
    // 生产逻辑等两帧再定位，模拟恢复完成早于迟到的默认指令。
    for (let frame = 0; frame < 2; frame++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    }
  });
  await render(null, true);
  const initial = { generation: 1, position: "initial" };
  await render(initial, true);
  await render(initial, false);
  await flushFrames();
  assert.deepEqual(scrolls, [], "首次默认定位不能覆盖恢复的阅读点");
  await render({ generation: 2, position: "initial" }, false);
  await flushFrames();
  assert.deepEqual(scrolls, [1500], "后续切换分支仍须按新上下文定位");
});
