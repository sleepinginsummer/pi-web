import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperty(dom.window, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
});
const { cleanup, fireEvent, render } = await import("@testing-library/react");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { NoticeShelf } = await jiti.import("./NoticeShelf.tsx");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

const notice = {
  id: "notice-1",
  message: "FFF init failed: complete diagnostic text",
  type: "error",
};

function renderShelf({ copyNoticeText = async () => {}, onDismiss = () => {} } = {}) {
  return render(React.createElement(NoticeShelf, {
    notices: [notice],
    closeLabel: "Close",
    copiedLabel: "Copied",
    copyNoticeText,
    onDismiss,
  }));
}

afterEach(() => {
  cleanup();
  mock.timers.reset();
});

test("keeps local temporary notices connected to the chat shelf", () => {
  assert.match(chatWindowSource, /className="notice-shelf-overlay"[\s\S]*?<NoticeShelf/);
  assert.doesNotMatch(chatWindowSource, /top: 12,\s*right: 12/);
});

test("short press dismisses without copying", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const copied = [];
  const dismissed = [];
  const { getByRole } = renderShelf({
    copyNoticeText: async (text) => copied.push(text),
    onDismiss: (id) => dismissed.push(id),
  });
  const button = getByRole("button");

  fireEvent.pointerDown(button, { button: 0 });
  mock.timers.tick(499);
  fireEvent.pointerUp(button);
  fireEvent.click(button);

  assert.deepEqual(copied, []);
  assert.deepEqual(dismissed, [notice.id]);
});

test("long press copies the complete message and suppresses the following click", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const copied = [];
  const dismissed = [];
  const { getByRole } = renderShelf({
    copyNoticeText: async (text) => copied.push(text),
    onDismiss: (id) => dismissed.push(id),
  });
  const button = getByRole("button");

  fireEvent.pointerDown(button, { button: 0 });
  await act(async () => {
    mock.timers.tick(500);
    await Promise.resolve();
  });
  fireEvent.pointerUp(button);
  fireEvent.click(button);

  assert.deepEqual(copied, [notice.message]);
  assert.deepEqual(dismissed, []);
  assert.equal(button.textContent?.includes("Copied"), true);
});

test("pointer cancellation prevents a pending long press", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const copied = [];
  const { getByRole } = renderShelf({ copyNoticeText: async (text) => copied.push(text) });
  const button = getByRole("button");

  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.pointerCancel(button);
  mock.timers.tick(500);

  assert.deepEqual(copied, []);
});

test("copy failure shows no success feedback and still suppresses the long-press click", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const dismissed = [];
  const { getByRole } = renderShelf({
    copyNoticeText: async () => { throw new Error("denied"); },
    onDismiss: (id) => dismissed.push(id),
  });
  const button = getByRole("button");

  fireEvent.pointerDown(button, { button: 0 });
  await act(async () => {
    mock.timers.tick(500);
    await Promise.resolve();
  });
  fireEvent.pointerUp(button);
  fireEvent.click(button);

  assert.deepEqual(dismissed, []);
  assert.equal(button.textContent?.includes("Copied"), false);
  assert.equal(button.textContent?.includes(notice.message), true);
});
