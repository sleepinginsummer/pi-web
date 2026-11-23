import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const observers = new Set();
class TestResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
  observe(target) { this.targets.add(target); }
  disconnect() { observers.delete(this); }
}
const viewport = new dom.window.EventTarget();
viewport.offsetTop = 0;
Object.defineProperty(dom.window, "visualViewport", { value: viewport });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  ResizeObserver: { configurable: true, value: TestResizeObserver },
});
// jsdom 不计算 CSS Module；交互断言使用原始类名，几何由下面的布局快照提供。
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
  virtualModules: { "./AskDialog.module.css": new Proxy({}, { get: (_target, key) => String(key) }) },
});
const { AskInputFlyout } = await jiti.import("./AskInputFlyout.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
afterEach(() => { cleanup(); viewport.offsetTop = 0; });

const question = {
  header: "网络测试",
  question: "这里是很长的问题正文。".repeat(30),
  multiSelect: true,
  options: [
    { label: "方案一", description: "长选项说明。".repeat(80) },
    { label: "方案二", description: "另一条很长的说明。".repeat(80) },
  ],
};

function mount(t, questions = [question]) {
  const bounds = { top: 64, bottom: 530 };
  t.mock.method(dom.window.HTMLElement.prototype, "getBoundingClientRect", function () {
    if (this.classList.contains("chat-window")) return { top: bounds.top, bottom: 760 };
    if (this.classList.contains("ask-input-flyout")) return { top: bounds.bottom - 560, bottom: bounds.bottom };
    return { top: 0, bottom: 0 };
  });
  const ask = { kind: "questionnaire", value: { toolCallId: "ask-mobile", questions, submitting: false, error: null } };
  const submitted = [];
  const actions = { submitQuestionnaire: (answers) => submitted.push(answers), cancelQuestionnaire() {}, select() {}, cancelSelect() {}, submitCustom() {}, stop() {} };
  const view = render(React.createElement(I18nProvider, null,
    React.createElement("div", { className: "chat-window" },
      React.createElement("div", { className: "composer-anchor" }, React.createElement(AskInputFlyout, { ask, actions, isMobile: true })))));
  const chat = view.container.querySelector(".chat-window");
  return { view, chat, bounds, submitted };
}

test("长问卷按输入框以上的空间限高，输入框增长和键盘变化后重新测量", (t) => {
  const { chat, bounds, view } = mount(t);
  // 原来固定 560px 会让顶部落在 -30px，超过聊天区顶部，无法滚回收起按钮。
  assert.ok(bounds.bottom - 560 < bounds.top);
  assert.equal(chat.style.getPropertyValue("--ask-available-height"), "458px");
  const observer = [...observers][0];
  assert.equal(observer.targets.has(chat), true);
  assert.equal(observer.targets.has(chat.querySelector(".composer-anchor")), true);
  bounds.bottom = 360;
  act(() => observer.callback());
  assert.equal(chat.style.getPropertyValue("--ask-available-height"), "288px");
  viewport.offsetTop = 100;
  act(() => viewport.dispatchEvent(new dom.window.Event("resize")));
  assert.equal(chat.style.getPropertyValue("--ask-available-height"), "252px");
  bounds.bottom = 470;
  act(() => viewport.dispatchEvent(new dom.window.Event("scroll")));
  assert.equal(chat.style.getPropertyValue("--ask-available-height"), "362px");
  view.unmount();
  assert.equal(chat.style.getPropertyValue("--ask-available-height"), "");
  assert.equal(observers.size, 0);
});

test("移动端收起再展开保留已填答案和滚动位置，底部提交仍可用", (t) => {
  const { view, submitted } = mount(t);
  fireEvent.click(screen.getByRole("button", { name: /方案一/ }));
  const body = view.container.querySelector(".ask-questionnaire-body");
  body.scrollTop = 350;
  fireEvent.click(screen.getByRole("button", { name: "Collapse question" }));
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.click(screen.getByRole("button", { name: "Expand question" }));
  assert.equal(view.container.querySelector(".ask-questionnaire-body"), body);
  assert.equal(body.scrollTop, 350);
  fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
  assert.deepEqual(submitted, [[{ kind: "options", optionIndexes: [0] }]]);
});

test("多问题导航切换时回到正文顶部，不遗留上一题的滚动偏移", (t) => {
  const { view } = mount(t, [question, { ...question, header: "下一题", question: "第二题" }]);
  const body = view.container.querySelector(".ask-questionnaire-body");
  body.scrollTop = 400;
  fireEvent.click(screen.getByRole("button", { name: "2. 下一题" }));
  assert.equal(body.scrollTop, 0);
  assert.equal(screen.getByRole("heading", { name: "第二题" }).textContent, "第二题");
  assert.ok(screen.getByRole("button", { name: "Collapse question" }));
});
