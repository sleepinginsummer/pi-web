import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { InputControlsMenu } = await jiti.import("../components/InputControlsMenu.tsx");
const { ToolPresetControl, FastModeControl, RunControls, PreferenceToggles } = await jiti.import("../components/InputControls.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const h = React.createElement;
const noop = () => {};

function menu(state, known) {
  const running = state === "running";
  const compacting = state === "compacting";
  return renderToStaticMarkup(h(I18nProvider, null, h(InputControlsMenu, {
    isMobile: true, isOpen: true, onClose: noop,
    modelControls: h(React.Fragment, null,
      !running && h(FastModeControl, { isMobile: true, modelState: { fastAvailable: true, fastEnabled: false }, onChange: noop }),
      h(ToolPresetControl, { isMobile: true, toolPreset: "configured", toolSelectionKnown: known,
        onChange: noop, isStrayClick: () => false, locked: running || compacting })),
    runControls: h(RunControls, { isMobile: true, isStreaming: running, isCompacting: compacting,
      showLabel: true, onCompact: noop, onAbort: noop, onAbortCompaction: noop, isStrayClick: () => false }),
    preferenceControls: h(PreferenceToggles, { isMobile: true, soundEnabled: true, onSoundToggle: noop,
      notificationEnabled: true, notificationPermission: "granted", onNotificationToggle: noop,
      endAction: h("button", { className: "message-stash-trigger" }, "▣") }),
  })));
}

test("移动端更多面板在窄屏和状态变化后保持紧凑且所有按钮可见", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const width of [320, 393, 430]) {
      await page.setViewportSize({ width, height: 852 });
      for (const state of ["idle", "running", "compacting"]) {
        for (const known of [false, true]) {
          await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
            <style>*{box-sizing:border-box}body{margin:0}button{font-family:sans-serif}</style>
            <div style="position:absolute;right:24px;bottom:250px;width:64px;height:32px">${menu(state, known)}</div>`);
          const bounds = await page.evaluate(() => {
            const panel = document.querySelector(".mobile-controls-menu").getBoundingClientRect();
            const buttons = [...document.querySelectorAll(".mobile-controls-menu button")].map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            });
            return { left: panel.left, right: panel.right, height: panel.height, buttons };
          });
          const label = `${width}px ${state} known=${known}`;
          assert.ok(bounds.left >= 8 && bounds.right <= width - 8, `${label}: 面板不得超出屏幕`);
          assert.ok(bounds.height <= 110, `${label}: 面板不应留下多余空行，实际 ${bounds.height}px`);
          for (const button of bounds.buttons) {
            assert.ok(button.left >= bounds.left && button.right <= bounds.right, `${label}: 按钮不得超出面板`);
          }
          for (let i = 0; i < bounds.buttons.length; i++) {
            for (const other of bounds.buttons.slice(i + 1)) {
              const button = bounds.buttons[i];
              assert.ok(button.right <= other.left || other.right <= button.left || button.bottom <= other.top || other.bottom <= button.top,
                `${label}: 按钮不得重叠`);
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
});
