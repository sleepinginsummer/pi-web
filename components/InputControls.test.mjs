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
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

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

function renderControls(isMobile) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(InputControls, {
        ...sharedProps,
        isMobile,
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
  assert.match(html, /class="mobile-controls-menu"/);
  assert.match(html, /display:none/);
});

test("open mobile menu renders its slots, row break, and close control without clipping", () => {
  const html = renderOpenMobileMenu();
  const menuTag = html.match(/<div class="mobile-controls-menu"[^>]+>/)?.[0] ?? "";

  assert.match(menuTag, /display:flex/);
  assert.match(menuTag, /flex-wrap:wrap/);
  assert.doesNotMatch(menuTag, /overflow/);
  assert.match(html, /role="switch"/);
  assert.match(html, />Fast<\/span>/);
  assert.match(html, /data-controls-row-break="true"/);
  assert.match(html, /aria-label="Collapse controls"/);
});

test("Fast switch renders for an available desktop model", () => {
  const html = renderControls(false);

  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, />Fast<\/span>/);
});
