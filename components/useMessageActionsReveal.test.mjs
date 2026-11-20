import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useMessageActionsReveal } = await jiti.import("./useMessageActionsReveal.ts");

/** 触屏的 pointerdown：jsdom 没有 PointerEvent，用 MouseEvent 补上 pointerType。 */
function pointerDown(target, pointerType) {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
}

async function mountHarness() {
  const dom = new JSDOM("<div id='root'></div><div id='outside'>别处</div>", { pretendToBeVisual: true });
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  function Harness() {
    const [visible, setVisible] = useState(false);
    const reveal = useMessageActionsReveal(visible, setVisible);
    return createElement("div", { ref: reveal.ref, onPointerDown: reveal.onPointerDown, "data-row": "" },
      createElement("span", { id: "text" }, "回复正文"),
      createElement("div", { "data-message-actions": "" }, createElement("button", { id: "copy" }, "复制")),
      createElement("span", { id: "state" }, visible ? "shown" : "hidden"));
  }

  const root = createRoot(dom.window.document.getElementById("root"));
  await act(async () => { root.render(createElement(Harness)); });

  const state = () => dom.window.document.getElementById("state").textContent;
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  };
  return { dom, state, unmount };
}

test("触屏按一下消息就显示动作栏，按别处收起", async () => {
  const { dom, state, unmount } = await mountHarness();
  try {
    assert.equal(state(), "hidden");

    // 触屏：按在正文上（纯文本没有 hover 可用）也要能叫出动作栏。
    await act(async () => { pointerDown(dom.window.document.getElementById("text"), "touch"); });
    assert.equal(state(), "shown");

    // 按在动作栏自己身上（复制按钮）不算「点别处」。
    await act(async () => { pointerDown(dom.window.document.getElementById("copy"), "touch"); });
    assert.equal(state(), "shown", "点复制按钮不能把动作栏收起来");

    // 按到消息外面：收起。
    await act(async () => { pointerDown(dom.window.document.getElementById("outside"), "touch"); });
    assert.equal(state(), "hidden");
  } finally {
    await unmount();
  }
});

test("鼠标指针仍走 hover，点一下不会把动作栏钉住", async () => {
  const { dom, state, unmount } = await mountHarness();
  try {
    await act(async () => { pointerDown(dom.window.document.getElementById("text"), "mouse"); });
    assert.equal(state(), "hidden", "桌面靠 onMouseEnter，pointerdown 不参与");
  } finally {
    await unmount();
  }
});
