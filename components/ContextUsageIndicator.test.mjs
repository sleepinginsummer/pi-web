import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ContextUsageIndicator, computeCacheHitRate } = await jiti.import("./ContextUsageIndicator.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("computeCacheHitRate 正确计算缓存命中率，无缓存时返回 null", () => {
  assert.equal(computeCacheHitRate(null), null);
  assert.equal(computeCacheHitRate({
    sessionId: "s1", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 },
    cost: 0.01,
  }), null);

  const rate = computeCacheHitRate({
    sessionId: "s1", userMessages: 2, assistantMessages: 2, toolCalls: 1, toolResults: 1, totalMessages: 6,
    tokens: { input: 150, output: 50, cacheRead: 800, cacheWrite: 50, total: 1050 },
    cost: 0.12,
  });
  assert.ok(rate !== null && Math.abs(rate - 80) < 0.001);
});

test("ContextUsageIndicator 渲染百分比环并在缺少上下文窗口时隐藏", () => {
  const emptyHtml = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ContextUsageIndicator, { contextUsage: null })),
  );
  assert.equal(emptyHtml, "");

  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ContextUsageIndicator, {
        contextUsage: { percent: 71.4, contextWindow: 258000, tokens: 184000 },
        sessionStats: {
          sessionId: "s1", userMessages: 3, assistantMessages: 3, toolCalls: 2, toolResults: 2, totalMessages: 10,
          tokens: { input: 152000, output: 40000, cacheRead: 1420000, cacheWrite: 68000, total: 1680000 },
          cost: 0.42,
        },
      })),
  );
  assert.match(html, />71%<\/span>/);
  assert.match(html, /#d97706/, "70%-84% 使用琥珀色进度环");
  assert.doesNotMatch(html, /缓存读 \/ 写|输入 \/ 输出/);
});
