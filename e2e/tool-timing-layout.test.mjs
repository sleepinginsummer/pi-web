import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MessageView } = await jiti.import("../components/MessageView.tsx");
const { CodemodeCallList } = await jiti.import("../components/CodemodeToolView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const h = React.createElement;

test("长工具名在窄屏上截断，普通卡片和子调用的开始时间、耗时保持可见", async () => {
  const now = Date.now();
  const names = ["bash", "mcp__magpie_artifacts__generate_visual_asset"];
  const message = { role: "assistant", content: names.map((name, index) => ({
    type: "toolCall", toolCallId: String(index), toolName: name, input: { command: "long command arguments" },
  })) };
  const clocks = new Map(["0", "1"].map((id) => [id, { durationMs: 5100, wallStartedAt: now }]));
  const html = renderToStaticMarkup(h(I18nProvider, null, h(React.Fragment, null,
    h(MessageView, { message, toolClocks: clocks }),
    h(CodemodeCallList, { calls: names.map((name) => ({ name, status: "running", startedAt: now, elapsedMs: 0 })), omitted: 0, isError: false }))));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const width of [320, 393, 720]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:Arial}button{font-family:Arial;width:100%}</style>${html}`);
      const times = await page.locator("[data-tool-timing]").evaluateAll((nodes) => nodes.map((node) => ({
        text: node.textContent,
        x: node.getBoundingClientRect().x,
        right: node.getBoundingClientRect().right,
        parentRight: node.closest("li,button").getBoundingClientRect().right,
      })));
      assert.equal(times.length, 4);
      for (const time of times) {
        assert.match(time.text, /^\d{2}:\d{2}:\d{2} · \d+\.\ds$/);
        assert.ok(time.x >= 0 && time.right <= width - 16 && time.right <= time.parentRight, `${width}px 时间行不得越界`);
      }
    }
  } finally {
    await browser.close();
  }
});
