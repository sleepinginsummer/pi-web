import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});
// jsdom 只用于运行真实 React 状态与保存交互；顶层、裁切和尺寸由下面的 Chromium 验证。
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TeamSidebarSection } = await jiti.import("../components/TeamSidebarSection.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("角色预设在有 transform 的手机侧栏内全屏打开、可编辑保存，键盘缩高后仍可操作", async (t) => {
  const presets = Array.from({ length: 12 }, (_, i) => ({
    id: `role-${i}`, name: `角色 ${i} ${"很长的角色名称".repeat(6)}`, prompt: `提示词 ${i}`, updatedAt: i + 1,
  }));
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    if (init.method === "PATCH") {
      const patch = JSON.parse(init.body);
      writes.push(patch);
      presets[0] = { ...presets[0], ...patch, updatedAt: 100 };
      return Response.json({ preset: presets[0], presets });
    }
    return Response.json({ presets });
  });
  let browser;
  try {
    render(React.createElement(I18nProvider, null,
      React.createElement("div", { className: "sidebar-container sidebar-open" },
        React.createElement(TeamSidebarSection, {
          teams: [], selectedSessionId: null, runningSessionIds: new Set(), awaitingInputSessionIds: new Set(),
          unreadSessionIds: new Set(), defaultCwd: "/tmp", onSelectMemberSession() {}, onOpenBoard() {}, onTeamsChanged() {},
        }))));
    fireEvent.click(screen.getByTitle("Role presets"));
    await waitFor(() => assert.equal(screen.getByLabelText("Role name").value, presets[0].name));
    const dialog = screen.getByRole("dialog", { name: "Role presets" });
    assert.equal(dialog.open, true);
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "修改后的角色" } });
    fireEvent.change(screen.getByLabelText("Role prompt"), { target: { value: "修改后的提示词" } });
    fireEvent.submit(dialog.querySelector("form"));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Save", exact: true }).disabled, false));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { name: "修改后的角色", prompt: "修改后的提示词", expectedUpdatedAt: 1 });
    const markup = document.body.innerHTML;
    browser = await chromium.launch();
    const page = await browser.newPage({ isMobile: true, hasTouch: true });
    for (const width of [320, 393, 430, 1024]) {
      await page.setViewportSize({ width, height: 852 });
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
        <style>*{box-sizing:border-box}body{margin:0;--bg:#fff;--border:#ddd;--text:#111}.sidebar-container{width:280px;height:852px;transform:translateX(0);overflow:hidden}</style>${markup}`);
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog");
        dialog.removeAttribute("open");
        dialog.showModal();
      });
      for (const height of width <= 640 ? [852, 360] : [852]) {
        await page.evaluate((height) => document.documentElement.style.setProperty("--app-viewport-height", `${height}px`), height);
        const bounds = await page.evaluate(() => {
          const dialog = document.querySelector("dialog");
          const field = dialog.querySelector("input");
          const rect = dialog.getBoundingClientRect();
          const input = field.getBoundingClientRect();
          const list = dialog.querySelector(".team-role-presets-list");
          const listRect = list.getBoundingClientRect();
          return { modal: dialog.matches(":modal"), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            fieldWidth: input.width, fieldFont: getComputedStyle(field).fontSize, listBottom: listRect.bottom,
            inputTop: input.top, listScrollable: list.scrollWidth > list.clientWidth,
            hit: document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2) === field };
        });
        const label = `${width}×${height}`;
        assert.equal(bounds.modal, true, `${label}: 必须进入原生模态顶层`);
        if (width <= 640) {
          assert.equal(bounds.width, width, `${label}: 不得被 280px 侧栏限制`);
          assert.equal(bounds.x, 0);
          assert.equal(bounds.y, 0);
          assert.equal(bounds.height, height, `${label}: 跟随键盘缩小后的可用高度`);
          assert.ok(bounds.fieldWidth >= width - 40, `${label}: 编辑区应占满宽度`);
          assert.equal(bounds.fieldFont, "16px");
          assert.ok(bounds.listBottom <= bounds.inputTop, `${label}: 角色列表位于编辑区上方`);
          assert.equal(bounds.listScrollable, true, `${label}: 多个长角色名横向滚动`);
        } else {
          assert.equal(bounds.width, 640);
          assert.equal(bounds.height, 440);
        }
        assert.equal(bounds.hit, true, `${label}: 输入框应可直接点击`);
        await page.getByLabel("Role name").fill("手机上编辑角色");
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.scrollIntoViewIfNeeded();
        const saveBox = await save.boundingBox();
        assert.ok(saveBox.y >= bounds.y && saveBox.y + saveBox.height <= bounds.y + bounds.height, `${label}: 保存按钮应能滚动到可见区域`);
      }
    }
    fireEvent.click(screen.getByRole("button", { name: "+ New preset" }));
    assert.equal(screen.getByLabelText("Role name").value, "");
    assert.equal(screen.getByLabelText("Role prompt").value, "");
    fireEvent.click(screen.getByRole("button", { name: presets[1].name, exact: true }));
    assert.equal(screen.getByLabelText("Role name").value, presets[1].name);
    assert.equal(screen.getByLabelText("Role prompt").value, presets[1].prompt);
    act(() => dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })));
    assert.equal(screen.queryByRole("dialog"), null, "关闭只应收起角色弹窗");
    assert.ok(screen.getByTitle("Role presets"), "侧栏入口仍在");
  } finally {
    await browser?.close();
    cleanup();
  }
});
