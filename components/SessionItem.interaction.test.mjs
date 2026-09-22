import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionItem } = await jiti.import("./SessionItem.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

afterEach(cleanup);

const session = {
  path: "/sessions/hover.jsonl",
  id: "hover-session",
  cwd: "/repo",
  name: "Stable hover title",
  created: "2026-03-01T00:00:00.000Z",
  modified: "2026-03-01T00:00:00.000Z",
  messageCount: 12,
  firstMessage: "Stable hover title",
};

test("桌面操作层垂直居中且悬浮前后几何稳定", () => {
  render(React.createElement(
    I18nProvider,
    null,
    React.createElement(SessionItem, {
      session,
      status: { isSelected: false, isRunning: false, isUnread: false, isPinned: true },
      mobile: { enabled: false, swipeOpen: false, onSwipeOpenChange() {} },
      actions: { onClick() {}, onTogglePinned() {} },
      tree: { hasChildren: true, collapsed: false, onToggleCollapse() {} },
    }),
  ));

  const row = document.querySelector("[data-session-row]");
  const slot = document.querySelector("[data-session-actions]");
  assert.ok(row);
  assert.ok(slot);
  const stableGeometry = `${slot.style.top}|${slot.style.right}|${slot.style.width}|${slot.style.height}|${slot.style.transform}`;
  assert.notEqual(stableGeometry, "||||");
  assert.equal(slot.parentElement === row, false);
  assert.ok(row.querySelector('button[title="Collapse forks"]'));
  assert.ok(row.querySelector("[data-session-pin-marker]"));
  assert.equal(slot.querySelectorAll("button").length, 0);
  assert.equal(slot.style.pointerEvents, "none");

  fireEvent.mouseEnter(row);
  assert.equal(document.querySelector("[data-session-actions]"), slot);
  assert.equal(`${slot.style.top}|${slot.style.right}|${slot.style.width}|${slot.style.height}|${slot.style.transform}`, stableGeometry);
  assert.equal(slot.querySelectorAll("button").length, 3);
  assert.equal(slot.style.pointerEvents, "auto");
  assert.ok(row.querySelector("[data-session-pin-marker]"));

  fireEvent.mouseLeave(row);
  assert.equal(`${slot.style.top}|${slot.style.right}|${slot.style.width}|${slot.style.height}|${slot.style.transform}`, stableGeometry);
  assert.equal(slot.querySelectorAll("button").length, 0);
  assert.equal(slot.style.pointerEvents, "none");
  assert.ok(row.querySelector("[data-session-pin-marker]"));
});

test("移动端选中会话在 Pin 后仍显示角标", () => {
  render(React.createElement(
    I18nProvider,
    null,
    React.createElement(SessionItem, {
      session,
      status: { isSelected: true, isRunning: false, isUnread: false, isPinned: true },
      mobile: { enabled: true, swipeOpen: false, onSwipeOpenChange() {} },
      actions: { onClick() {}, onTogglePinned() {} },
    }),
  ));

  const row = document.querySelector("[data-session-row]");
  assert.ok(row);
  assert.ok(row.querySelector("[data-session-pin-marker]"));
});
