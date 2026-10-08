import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  extensionStatusCommand,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ExtensionStatusBar, props)),
  );
}

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

test("preserves explicit status lines without wrapping and scrolls long or tall output", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const statusLineRule = css.match(/(?:^|\n)\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const statusTextRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(statusLineRule, /max-height:/);
  assert.match(statusLineRule, /align-items:\s*flex-start/);
  assert.match(statusLineRule, /overflow:\s*auto/);
  assert.match(statusTextRule, /white-space:\s*pre\s*;/);
  assert.doesNotMatch(statusTextRule, /overflow[^:]*:\s*hidden/);
  assert.doesNotMatch(statusTextRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(statusTextRule, /text-overflow:\s*ellipsis/);
});

test("状态栏保留本地高度并按键排序显示独立状态", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });
  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-bar/);
  assert.match(html, /height:36px/);
  assert.match(html, /border-top:1px solid var\(--border\)/);
  assert.match(html, /background:transparent/);
  assert.equal(html.match(/class="extension-status-item"/g)?.length, 2);
  assert.match(html, /extension-status-item"><span>ponytail<\/span><\/span>/);
  assert.match(html, /<span style="[^"]*">memory<\/span>/);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
  assert.doesNotMatch(html, /<button/);
});

test("a status with nothing visible to show gets no cell", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "a", text: "   " },
      { key: "b", text: "\x1b[0m" },
      { key: "c", text: "shown" },
    ],
  });

  assert.equal(html.match(/class="extension-status-item"/g)?.length, 1);
  assert.match(html, /aria-label="shown"/);
  assert.equal(renderStatusBar({ statuses: [{ key: "a", text: "" }] }), "");
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
  const statusTag = html.match(/<div role="status" class="extension-status-line"[^>]*>/)?.[0] ?? "";

  assert.doesNotMatch(outerTag, /role="status"/);
  assert.match(statusTag, /role="status"/);
  assert.match(statusTag, /aria-label="memory ready"/);
  assert.match(html, /class="extension-widget-trigger is-expanded"/);
  assert.match(html, /aria-controls=/);
});

test("reads a slash command from a command: status key", () => {
  assert.equal(extensionStatusCommand("command:/mode toggle"), "/mode toggle");
  assert.equal(extensionStatusCommand("command:  /mode  "), "/mode");
  // Only slash commands are buttons: plain text would reach the model, and
  // "!" would run a shell command.
  assert.equal(extensionStatusCommand("command:hello"), null);
  assert.equal(extensionStatusCommand("command:!ls"), null);
  assert.equal(extensionStatusCommand("command:/"), null);
  assert.equal(extensionStatusCommand("command:"), null);
  assert.equal(extensionStatusCommand("mode"), null);
  assert.equal(extensionStatusCommand("chip:/mode toggle"), null);
});

test("renders a command status as a button cell between the text cells around it, in key order", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "zz-last", text: "last" },
      { key: "command:/mode toggle", text: "\x1b[32m🔨 Build\x1b[0m" },
      { key: "aa-first", text: "first" },
    ],
    onCommand: () => {},
  });

  assert.match(html, /aria-label="first 🔨 Build last"/);
  assert.match(
    html,
    /first<\/span><\/span><button[^>]*class="extension-status-item extension-status-command"[^>]*aria-label="🔨 Build \(\/mode toggle\)"[^>]*>🔨 Build<\/button><span class="extension-status-item"><span>last/,
  );
  assert.doesNotMatch(html, /disabled/);
  // The key is not shown as text.
  assert.doesNotMatch(html, />command:/);
});

test("an onCommand handler changes nothing for statuses without a command", () => {
  const statuses = [
    { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
    { key: "05-ponytail", text: "ponytail" },
  ];
  assert.equal(
    renderStatusBar({ statuses, onCommand: () => {} }),
    renderStatusBar({ statuses }),
  );
  assert.doesNotMatch(renderStatusBar({ statuses }), /<button/);
});

test("a command key that is not a slash command stays plain status text", () => {
  const html = renderStatusBar({
    statuses: [{ key: "command:hello", text: "hello" }],
    onCommand: () => {},
  });

  assert.doesNotMatch(html, /<button/);
  assert.match(html, />hello</);
});

test("falls back to the command when the status text is empty", () => {
  const html = renderStatusBar({
    statuses: [{ key: "command:/mode toggle", text: "\x1b[1m \x1b[0m" }],
    onCommand: () => {},
  });

  assert.match(html, /aria-label="\/mode toggle \(\/mode toggle\)"[^>]*>\/mode toggle<\/button>/);
});

test("command buttons are disabled while commands are blocked or nothing can send them", () => {
  const statuses = [{ key: "command:/mode toggle", text: "Plan" }];

  assert.match(renderStatusBar({ statuses, onCommand: () => {}, commandsDisabled: true }), /<button[^>]*disabled/);
  assert.match(renderStatusBar({ statuses }), /<button[^>]*disabled/);
  assert.doesNotMatch(renderStatusBar({ statuses, onCommand: () => {} }), /<button[^>]*disabled/);
});

test("clicking a command button sends its command", () => {
  const sent = [];
  // The component has no hooks, so calling it returns the element tree.
  const tree = ExtensionStatusBar({
    statuses: [{ key: "command:/mode toggle", text: "Plan" }],
    onCommand: (command) => sent.push(command),
  });
  const buttons = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "button") buttons.push(node);
    walk(node.props?.children);
  };
  walk(tree);

  assert.equal(buttons.length, 1);
  buttons[0].props.onClick();
  assert.deepEqual(sent, ["/mode toggle"]);
});

test("marks the shelf only when it has a command button", () => {
  const plain = renderStatusBar({ statuses: [{ key: "status", text: "connected" }], onCommand: () => {} });
  const withCommand = renderStatusBar({
    statuses: [{ key: "command:/mode toggle", text: "Plan" }],
    onCommand: () => {},
  });

  assert.doesNotMatch(plain, /has-commands/);
  assert.match(withCommand, /class="extension-status-bar has-statuses has-commands"/);
});

test("every status is a cell divided by vertical rules, and a command cell is a button with no box border", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const lineRule = css.match(/(?:^|\n)\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const rowRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";
  const cellRule = css.match(/\.extension-status-item\s*\{([^}]*)\}/)?.[1] ?? "";
  const buttonRule = css.match(/\.extension-status-command\s*\{([^}]*)\}/)?.[1] ?? "";

  // The cells carry the padding, so a cell can fill the whole height of the line.
  assert.match(lineRule, /padding:\s*0\s*;/);
  assert.match(rowRule, /display:\s*flex/);
  assert.match(rowRule, /align-items:\s*stretch/);
  assert.match(cellRule, /padding:\s*8px 12px/);
  assert.match(cellRule, /border-right:\s*1px solid/);
  assert.match(cellRule, /flex:\s*0 0 auto/);
  assert.match(css, /\.extension-status-item:last-child\s*\{[^}]*border-right:\s*0/);
  // The button keeps the cell's rule on its right and draws no box.
  assert.doesNotMatch(buttonRule, /border-radius/);
  assert.doesNotMatch(buttonRule, /border-right/);
  assert.match(buttonRule, /border-left:\s*0/);
  assert.match(buttonRule, /white-space:\s*nowrap/);
  assert.match(buttonRule, /font:\s*inherit/);
  assert.match(css, /\.extension-status-command:disabled\s*\{[^}]*not-allowed/);
  // Touch screens get taller cells only when there is something to tap.
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.extension-status-shelf\.has-commands \.extension-status-text\s*\{[^}]*min-height:\s*44px/);
  // The widget triggers beside the cells grow with them, or the row would be uneven.
  assert.match(css, /\.extension-status-shelf\.has-commands \.extension-widget-triggers,\s*\.extension-status-shelf\.has-commands \.extension-widget-trigger\s*\{[^}]*height:\s*44px/);
});

test("小组件折叠入口保留在状态文本之前", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{ key: "usage", lines: ["a", "b"], placement: "aboveEditor" }],
  });
  const triggers = html.indexOf("extension-widget-triggers");
  const line = html.indexOf("extension-status-line");
  assert.ok(triggers !== -1 && triggers < line);
  assert.match(html, /aria-expanded="true"/);
});

test("仅有小组件时保持可操作的折叠入口", () => {
  const plain = renderStatusBar({ statuses: [{ key: "status", text: "connected" }] });
  assert.doesNotMatch(plain, /extension-widget-trigger/);
  const html = renderStatusBar({
    statuses: [],
    widgets: [{ key: "usage", lines: ["a"], placement: "aboveEditor" }],
  });
  assert.match(html, /extension-widget-trigger/);
  assert.doesNotMatch(html, /extension-status-line/);
});

test("the shared row scrolls sideways as a whole; its triggers and status line do not scroll on their own", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const rowRule = css.match(/(?:^|\n)\.extension-status-row\s*\{([^}]*)\}/)?.[1] ?? "";
  const triggersRule = css.match(/(?:^|\n)\.extension-widget-triggers\s*\{([^}]*)\}/)?.[1] ?? "";
  const lineInRowRule = css.match(/\.extension-status-row > \.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(rowRule, /overflow-x:\s*auto/);
  assert.match(rowRule, /display:\s*flex/);
  // Nothing inside may shrink or clip, or the row would never overflow.
  assert.match(triggersRule, /flex:\s*0 0 auto/);
  assert.doesNotMatch(triggersRule, /overflow/);
  assert.doesNotMatch(css, /\.extension-widget-triggers[^{]*\{[^}]*max-width:\s*70%/);
  assert.match(lineInRowRule, /flex:\s*0 0 auto/);
});
