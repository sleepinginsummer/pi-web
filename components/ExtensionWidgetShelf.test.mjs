import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ExtensionWidgetShelf } = await jiti.import("./ExtensionWidgetShelf.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("expanded widget panel renders ANSI colors instead of raw escape codes", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ExtensionWidgetShelf, {
      widgets: [{
        key: "rpiv-todos",
        placement: "aboveEditor",
        lines: [
          "\x1b[38;5;5m●\x1b[39m \x1b[38;5;5mTodos (0/1)\x1b[39m",
          "\x1b[2m└─\x1b[22m \x1b[38;5;3m◐\x1b[39m 验证结果",
        ],
      }],
    })),
  );

  assert.match(html, /extension-widget-content/);
  assert.match(html, /Todos \(0\/1\)/);
  assert.doesNotMatch(html, /\x1b/);
  assert.doesNotMatch(html, /\[38;5;5m/);
  assert.doesNotMatch(html, /\[39m/);
});

test("opens rpiv-todos in the left popover while other widgets keep their panel", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
  t.after(() => {
    cleanup();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });

  const { ExtensionStatusBar } = await jiti.import("./ExtensionStatusBar.tsx");
  const { container, getByRole, queryByRole } = render(React.createElement(I18nProvider, null,
    React.createElement(ExtensionStatusBar, {
      statuses: [],
      leading: React.createElement("button", null, "Scheduled tasks"),
      widgets: [
        { key: "status-widget", placement: "aboveEditor", lines: ["First", "Second"] },
        { key: "rpiv-todos", placement: "aboveEditor", lines: ["Todos (0/1)", "└─ ◐ 验证结果"] },
      ],
    }),
  ));
  const trigger = getByRole("button", { name: /^rpiv-todos/ });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(queryByRole("region", { name: "rpiv-todos" }), null);
  assert.equal(container.querySelector(".extension-status-bar").children[1], trigger.closest(".extension-widget-left-shelf"));

  fireEvent.click(trigger);
  const todo = getByRole("region", { name: "rpiv-todos" });
  const other = getByRole("region", { name: "status-widget" });
  assert.ok(todo.parentElement.classList.contains("extension-widget-panels-left"));
  assert.ok(!other.parentElement.classList.contains("extension-widget-panels-left"));
  assert.match(todo.textContent, /验证结果/);
  fireEvent.keyDown(dom.window.document, { key: "Escape" });
  assert.equal(queryByRole("region", { name: "rpiv-todos" }), null);

  fireEvent.click(trigger);
  fireEvent.pointerDown(getByRole("button", { name: "Scheduled tasks" }));
  assert.equal(queryByRole("region", { name: "rpiv-todos" }), null);
});
