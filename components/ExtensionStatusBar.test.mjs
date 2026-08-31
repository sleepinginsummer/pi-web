import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("sanitizes status text for a single-line display", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second third",
  );
});

test("removes only a separator that appears at the start of the full status line", () => {
  const cacheStatus = { key: "pi-cache-stats", text: "· OpenAI cache 0/0·0M/0M 0.0%" };

  assert.equal(formatExtensionStatusLine([cacheStatus]), "OpenAI cache 0/0·0M/0M 0.0%");
  assert.equal(
    formatExtensionStatusLine([{ key: "active-goal", text: "goal" }, cacheStatus]),
    "goal · OpenAI cache 0/0·0M/0M 0.0%",
  );
});

test("renders a single status line without identifier keys", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionStatusBar, {
      statuses: [
        { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
        { key: "05-ponytail", text: "ponytail" },
      ],
    }),
  );

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /height:36px/);
  assert.match(html, /border-top:1px solid var\(--border\)/);
  assert.match(html, /background:transparent/);
  assert.match(html, /font-family:var\(--font-mono\)/);
  assert.match(html, />ponytail <\/span>/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("keeps widget controls outside the status live region", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ExtensionStatusBar, {
        statuses: [{ key: "20-memory", text: "memory ready" }],
        widgets: [{ key: "tasks", lines: ["first", "second"], placement: "aboveEditor" }],
      })),
  );
  const outerTag = html.match(/<div class="extension-status-bar[^"]*"[^>]*>/)?.[0] ?? "";
  const statusTag = html.match(/<span class="extension-status-line"[^>]*>/)?.[0] ?? "";

  assert.doesNotMatch(outerTag, /role="status"/);
  assert.match(statusTag, /role="status"/);
  assert.match(statusTag, /aria-label="memory ready"/);
  assert.match(html, /class="extension-widget-trigger is-expanded"/);
  assert.match(html, /aria-controls=/);
});
