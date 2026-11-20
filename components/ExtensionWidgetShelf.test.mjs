import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("触发器的图标在前、折叠符在最后", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ExtensionWidgetShelf, {
      widgets: [{ key: "rpiv-todos", placement: "aboveEditor", lines: ["a", "b"] }],
      compactLabel: "chat.todos",
      icon: React.createElement("svg", { "data-test-icon": "1" }),
    })),
  );
  const icon = html.indexOf("data-test-icon");
  const label = html.indexOf("extension-widget-key");
  const chevron = html.indexOf("extension-widget-placement");
  assert.ok(icon !== -1 && icon < label && label < chevron, `${icon}/${label}/${chevron}`);
  // 旧的写法是折叠符在最前，这条挡住回退。
  assert.doesNotMatch(html, /extension-widget-placement[\s\S]{0,200}?extension-widget-key/);
});

test("底栏入口的样式：图标和折叠符同宽，折叠符贴右、文字不撑满整行", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start > 0, selector);
    return css.slice(start, css.indexOf("}", start));
  };
  // 三个入口（服务器/任务、待办、扩展状态）用同一套盒子：图标 12px，折叠符贴右。
  assert.match(rule(".extension-widget-icon"), /width: 12px/);
  assert.match(rule(".extension-widget-placement"), /margin-left: auto/);
  // 文字不再 flex:1 撑满：计数徽标才能紧跟文字，空隙留给折叠符。
  assert.match(rule(".extension-widget-key"), /flex: 0 1 auto/);
});
