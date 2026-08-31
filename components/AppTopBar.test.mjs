import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AppTopBar } = await jiti.import("./AppTopBar.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const labels = {
  "common.language": "Language",
  "history.full": "Full history",
  "history.label": "Full history",
  "history.unsaved": "History unavailable",
  "i18n.branches": "Branches",
  "session.title": "Session info",
  "sidebar.hide": "Hide sidebar",
  "sidebar.show": "Show sidebar",
  "system.label": "System",
  "system.prompt": "System prompt",
  "theme.dark": "Dark theme",
  "theme.light": "Light theme",
  "title.generate": "Generate title",
  "trust.resourcesNotLoaded": "Resources unavailable",
};
const translate = (key) => labels[key] ?? key;

function renderTopBar(isMobile) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(AppTopBar, {
        activePanel: null,
        endAction: React.createElement("button", { type: "button", "aria-label": "File panel" }),
        locale: "en",
        navigation: {
          activeLeafId: null,
          branchTree: [],
          isMobile,
          onLeafChange() {},
          onSidebarToggle() {},
          sidebarOpen: false,
          topBarRef: React.createRef(),
        },
        onTogglePanel() {},
        session: {
          agentCount: 0,
          autoNameStatus: { kind: "idle" },
          contextUsage: { percent: 62, contextWindow: 1000, tokens: 620 },
          hasPersistedSession: true,
          identityKey: "session-1",
          messageCount: 1,
          onAutoName() {},
          onHistory() {},
          shadowControl: {
            scopeKey: "session-1",
            sessionId: "session-1",
            enabled: true,
            pending: false,
            available: true,
            onToggle() {},
          },
          show: true,
          stats: null,
          systemPrompt: "prompt",
        },
        translate,
        trust: { needsTrust: false, onOpen() {} },
      })),
  );
}

test("medium mobile top bar renders semantic icons in a horizontally scrollable action region", () => {
  const html = renderTopBar(true);

  assert.match(html, /class="app-top-bar"/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /touch-action:pan-x/);
  assert.match(html, /lucide-history/);
  assert.match(html, /lucide-sparkles/);
  assert.match(html, /lucide-scroll-text/);
  assert.doesNotMatch(html, />62%/);
});

test("file panel action is a non-scrolling end slot outside the top-bar action region", () => {
  const html = renderTopBar(true);
  assert.match(html, /class="app-top-bar-shell"/);
  assert.match(html, /<\/div><div class="app-top-bar-end"[^>]*><button type="button" aria-label="File panel"><\/button><\/div>/);
  assert.doesNotMatch(html, /padding-right:36px/);
});

test("desktop top bar keeps text labels", () => {
  const html = renderTopBar(false);

  assert.match(html, />Full history<\/button>/);
  assert.match(html, />Generate title<\/button>/);
  assert.match(html, />System<\/button>/);
  assert.doesNotMatch(html, /Language|theme/);
});
