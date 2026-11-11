import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
