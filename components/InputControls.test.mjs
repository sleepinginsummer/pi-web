import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { InputControls } = await jiti.import("./InputControls.tsx");
const { InputControlsMenu } = await jiti.import("./InputControlsMenu.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const modelState = {
  names: {},
  list: [],
  error: null,
  scopeWarnings: [],
  dataDiagnostics: [],
  thinkingLevel: "low",
  model: { provider: "openai", modelId: "gpt-test" },
  isAutoModelSelection: false,
  availableThinkingLevels: ["low", "high"],
  thinkingLevelMap: null,
  fastEnabled: false,
  fastAvailable: true,
  fastPending: false,
};

const sharedProps = {
  isStreaming: false,
  modelState,
  modelActions: { changeFastEnabled() {} },
  onThinkingLevelChange() {},
  toolPreset: "default",
  onToolPresetChange() {},
  onCompact() {},
  onAbort() {},
  soundEnabled: true,
  onSoundToggle() {},
  notificationEnabled: true,
  notificationPermission: "granted",
  onNotificationToggle() {},
};

function renderControls(isMobile, overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(InputControls, {
        ...sharedProps,
        isMobile,
        ...overrides,
      })),
  );
}

function renderOpenMobileMenu() {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(InputControlsMenu, {
        isMobile: true,
        isOpen: true,
        modelControls: React.createElement("button", { type: "button", role: "switch", "aria-checked": false }, React.createElement("span", null, "Fast")),
        onClose() {},
        preferenceControls: React.createElement("button", { type: "button" }, "Sound"),
        runControls: React.createElement("button", { type: "button" }, "Compact"),
      })),
  );
}

test("mobile controls expose the closed menu trigger", () => {
  const html = renderControls(true);

  assert.match(html, /aria-label="More controls"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /class="mobile-controls-menu"/);
});

test("open mobile menu groups model actions and preferences", () => {
  const html = renderOpenMobileMenu();
  assert.match(html, /class="mobile-controls-menu" role="group"/);
  assert.match(html, /role="switch"/);
  assert.match(html, />Fast<\/span>/);
  assert.ok(html.indexOf('class="mobile-controls-actions"') < html.indexOf('class="mobile-controls-preferences"'));
  assert.match(html, /aria-label="Collapse controls"/);
});

test("Fast switch renders for an available desktop model", () => {
  const html = renderControls(false);

  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, />Fast<\/span>/);
});


test("stop remains directly available during a mobile run", () => {
  const html = renderControls(true, { isStreaming: true });
  assert.match(html, /class="mobile-composer-stop"/);
  assert.doesNotMatch(html, /class="mobile-controls-menu"/);
});
