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

function renderShelf({ copyNoticeText = async () => {}, onToggleExpanded = () => {}, expanded = false } = {}) {
  return render(React.createElement(NoticeShelf, {
    notices: [{ ...notice, expanded }],
    copyLabel: "Copy",
    copiedLabel: "Copied",
    copyNoticeText,
    onToggleExpanded,
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

test("clicking a collapsed notice expands it instead of dismissing it", () => {
  const toggled = [];
  const { getByRole, queryByRole } = renderShelf({ onToggleExpanded: (id, value) => toggled.push([id, value]) });
  const toggle = getByRole("button");

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(queryByRole("button", { name: "Copy" }), null);
  fireEvent.click(toggle);

  assert.deepEqual(toggled, [[notice.id, true]]);
});

test("clicking an expanded notice collapses it", () => {
  const toggled = [];
  const { getByRole } = renderShelf({ expanded: true, onToggleExpanded: (id, value) => toggled.push([id, value]) });
  const toggle = getByRole("button", { expanded: true });

  fireEvent.click(toggle);

  assert.deepEqual(toggled, [[notice.id, false]]);
});

test("copy button copies the complete message without collapsing", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const copied = [];
  const toggled = [];
  const { getByRole } = renderShelf({
    expanded: true,
    copyNoticeText: async (text) => copied.push(text),
    onToggleExpanded: (id, value) => toggled.push([id, value]),
  });
  const copy = getByRole("button", { name: "Copy" });

  await act(async () => {
    fireEvent.click(copy);
    await Promise.resolve();
  });

  assert.deepEqual(copied, [notice.message]);
  assert.deepEqual(toggled, []);
  assert.equal(copy.textContent, "Copied");
  await act(async () => {
    mock.timers.tick(1_500);
  });
  assert.equal(copy.textContent, "Copy");
});

test("copy failure shows no success feedback", async () => {
  const { getByRole } = renderShelf({
    expanded: true,
    copyNoticeText: async () => { throw new Error("denied"); },
  });
  const copy = getByRole("button", { name: "Copy" });

  await act(async () => {
    fireEvent.click(copy);
    await Promise.resolve();
  });

  assert.equal(copy.textContent, "Copy");
});

test("terminal QR codes in a notice keep every space and one monospace grid (#755)", () => {
  const qr = "█▀▀▀▀▀█ ▄ █▀▀▀▀▀█\n█ ███ █  ▀█ ███ █";
  const { container } = render(React.createElement(NoticeShelf, {
    notices: [{ id: "qr", message: `Scan to sign in:\n${qr}\nthen return here`, type: "info" }],
    copyLabel: "Copy",
    copiedLabel: "Copied",
    onToggleExpanded() {},
  }));
  const art = container.querySelector(".notice-shelf-art");
  assert.ok(art, "the block-character lines render as terminal art");
  assert.equal(art.textContent, qr);
  assert.match(container.querySelector(".notice-shelf-message").textContent, /^Scan to sign in:\n[\s\S]*\nthen return here$/);
});
