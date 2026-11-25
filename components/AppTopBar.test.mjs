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
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

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

function renderTopBar(isMobile, outline = { available: false, open: false, onToggle() {} }, workspaceToolbarRef) {
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
        outline,
        workspaceToolbarRef,
        session: {
          agentsBadge: null,
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

test("mobile toolbar shows More and keeps secondary controls collapsed", () => {
  const html = renderTopBar(true);
  assert.match(html, /class="mobile-top-bar-more" aria-expanded="false"/);
  assert.doesNotMatch(html, /Full history|Generate title|aria-label="System"|overflow-x:auto/);
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

test("mobile outline button sits right before More and follows availability", () => {
  const html = renderTopBar(true, { available: true, open: false, onToggle() {} });
  const outlineAt = html.indexOf('data-mobile-outline-button');
  const moreAt = html.indexOf('class="mobile-top-bar-more"');
  assert.ok(outlineAt > 0, "有轮次时出现大纲按钮");
  assert.ok(outlineAt < moreAt, "大纲按钮排在「更多」前面");
  assert.match(html, /data-mobile-outline-button="" aria-pressed="false"/);

  // 没有轮次（新会话）时不出现，避免点开是空的。
  const none = renderTopBar(true, { available: false, open: false, onToggle() {} });
  assert.doesNotMatch(none, /data-mobile-outline-button/);
});

test("工作区槽位位于移动端顶栏内，与大纲和更多同一行", () => {
  const html = renderTopBar(true, { available: true, open: false, onToggle() {} }, () => {});
  const primary = html.slice(html.indexOf('class="mobile-top-bar-primary"'), html.indexOf('class="app-top-bar-end"'));
  const workspaceAt = primary.indexOf('class="mobile-workspace-slot"');
  const outlineAt = primary.indexOf("data-mobile-outline-button");
  assert.ok(workspaceAt > 0 && workspaceAt < outlineAt);
  assert.match(primary, /class="mobile-top-bar-more"/);
  assert.doesNotMatch(renderTopBar(false, undefined, () => {}), /mobile-workspace-slot/);
});
