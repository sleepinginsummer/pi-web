import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { calculateModelPickerPanelLayout } = await jiti.import("./ModelPicker.tsx");
const source = await readFile(new URL("./ModelPicker.tsx", import.meta.url), "utf8");

const baseGeometry = {
  triggerTop: 760,
  triggerLeft: 12,
  triggerWidth: 220,
  viewportTop: 0,
  viewportLeft: 0,
  viewportWidth: 390,
  viewportHeight: 844,
  layoutHeight: 844,
};

test("移动端打开模型列表时不自动聚焦搜索框", () => {
  assert.match(source, /autoFocus=\{!isMobile\}/);
});

test("移动键盘弹出后模型列表保持在 visual viewport 内", () => {
  const geometry = {
    ...baseGeometry,
    viewportTop: 24,
    viewportHeight: 486,
  };
  const layout = calculateModelPickerPanelLayout(geometry, true);
  const panelBottom = geometry.layoutHeight - Number(layout.bottom);
  const panelTop = panelBottom - Number(layout.maxHeight);

  assert.ok(panelTop >= geometry.viewportTop + 8);
  assert.ok(panelBottom <= geometry.viewportTop + geometry.viewportHeight - 8);
  assert.equal(layout.left, 8);
  assert.equal(layout.width, 374);
});

test("桌面端模型列表继续锚定在触发按钮上方", () => {
  const layout = calculateModelPickerPanelLayout(baseGeometry, false);

  assert.equal(layout.bottom, 90);
  assert.equal(layout.left, 12);
  assert.equal(layout.minWidth, 220);
});
