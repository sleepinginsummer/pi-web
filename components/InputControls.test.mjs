import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { InputControls, MobileComposerMenu } = await jiti.import("./InputControls.tsx");
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

test("the phone's More trigger lives above the input, not in the bottom row", () => {
  // 输入框下方那一行只留运行控制与暂存库：模型名称、思考强度、Stop 才排得开。
  const row = renderControls(true);
  assert.doesNotMatch(row, /aria-label="More controls"/);

  const menu = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MobileComposerMenu, { ...sharedProps })),
  );
  assert.match(menu, /aria-label="More controls"/);
  assert.match(menu, /aria-expanded="false"/);
  assert.match(menu, /mobile-composer-more is-compact/);
  assert.doesNotMatch(menu, /class="mobile-controls-menu"/);
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

test("keeps the tool preset visible but locked during a run", () => {
  const html = renderControls(false, { isStreaming: true });

  // 运行中只能显示：按钮仍在，带着当前预设名，但不能点开菜单。
  assert.match(html, /aria-label="Change tool preset"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, />default<\/span>/, "chip 展示英文预设短名");
  assert.match(html, /title="[^"]*"/);
  assert.doesNotMatch(html, /No tools/);
});

test("leaves the tool preset clickable when idle", () => {
  const html = renderControls(false);

  assert.match(html, /aria-label="Change tool preset"/);
  assert.doesNotMatch(html, /aria-disabled="true"/);
});

test("the phone's More menu keeps the tool row but no longer hides reasoning", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
  // 移动端菜单的内容只有一份（MobileComposerMenu）：Fast + 工具预设，思考强度已经移到下方那一行。
  const menu = source.slice(source.indexOf("export const MobileComposerMenu"), source.indexOf("interface ComposerTopUtilitiesProps"));
  assert.match(menu, /modelControls=\{/);
  assert.ok(menu.includes("ToolPresetControl"));
  assert.ok(!menu.includes("ThinkingControl"), "思考强度不再藏在「更多」里");
  assert.doesNotMatch(menu, /!isStreaming && <ToolPresetControl/);
  assert.match(menu, /<ToolPresetControl[^>]*disabled=\{isStreaming\}/);

});

test("shows the configured preset's tools without editing them from the menu", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // configured 的名单只在 Settings › General 里改：菜单只展示，勾选禁用并给出去处。
  assert.match(source, /const followsSettings = toolPreset === "configured" && !customToolNames;/);
  assert.match(source, /disabled=\{!selectedTools \|\| followsSettings\}/);
  assert.match(source, /followsSettings \? "cursor-default" : "cursor-pointer"/);
  assert.match(source, /\{followsSettings && \([\s\S]*?chat\.toolsFollowSettingsHint/);
});

test("marks a settings-enabled tool this session runs without", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // 每次打开菜单都读一遍设置（配置来源比 configured 单一用途更广）。
  assert.match(source, /if \(!toolDropdownOpen \|\| configuredTools\) return;/);
  // 钉死名单存在时以它为准，没有就以设置为准；两者都由 missingBuiltinTools 判定。
  assert.match(source, /missingBuiltinTools\(configuredTools, pinnedToolNames \?\? configuredTools, activeBuiltinTools\)/);
  assert.match(source, /\{missingHere\.includes\(name\) && \([\s\S]*?chat\.toolMissingHere/);
});

test("names every preset from one i18n source in the chip and the menu", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // chip 与菜单行共用同一个 key 函数，统一展示英文短名（off/configured/read-only/default/full/custom）。
  assert.match(source, /const toolPresetLabel = !toolSelectionKnown[\s\S]*?\? t\("chat\.customToolSelection"\)[\s\S]*?: t\(toolPresetLabelKey\(toolPreset \?\? "default"\)\);/);
  assert.match(source, /const name = t\(toolPresetLabelKey\(preset\)\);/);
  // 说明和名字重复（例如"不使用工具"）时不再重复一行。
  assert.match(source, /desc !== name &&/);
});
