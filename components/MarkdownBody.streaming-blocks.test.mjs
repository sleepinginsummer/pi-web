import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
// jsdom 没有 matchMedia，代码块高亮会通过 useTheme 读系统配色。
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});

// 用一层 spy 包住 react-markdown，统计每次提交真正重新解析了多少个块。
// 计数器挂在 globalThis 上，避免 jiti 与测试各自加载模块时拿到两个实例。
// spy 文件必须放在仓库内，才能按正常规则解析 react 依赖。
const reactMarkdownEntry = new URL("../node_modules/react-markdown/index.js", import.meta.url).href;
const spyCacheRoot = join(process.cwd(), "node_modules", ".cache");
mkdirSync(spyCacheRoot, { recursive: true });
const spyDirectory = mkdtempSync(join(spyCacheRoot, "pi-web-markdown-spy-"));
const spyPath = join(spyDirectory, "react-markdown-spy.mjs");
writeFileSync(
  spyPath,
  [
    'import React from "react";',
    `import ReactMarkdown from ${JSON.stringify(reactMarkdownEntry)};`,
    "",
    "export default function ReactMarkdownSpy(props) {",
    "  globalThis.__reactMarkdownParseCount = (globalThis.__reactMarkdownParseCount ?? 0) + 1;",
    "  return React.createElement(ReactMarkdown, props);",
    "}",
    "",
  ].join("\n"),
);

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: { "react-markdown": spyPath },
});
const { cleanup, render } = await import("@testing-library/react");
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitStreamingMarkdown } = await jiti.import("@/lib/streaming-markdown-blocks");

afterEach(() => {
  cleanup();
  globalThis.__reactMarkdownParseCount = 0;
});
after(() => {
  rmSync(spyDirectory, { recursive: true, force: true });
});

function blockDocument(tail) {
  const lines = [];
  for (let index = 1; index <= 6; index++) {
    lines.push(`## 小节 ${index}`, "", `第 ${index} 段说明文字。`, "");
  }
  lines.push("```ts", "const a = 1;", "```", "");
  lines.push("| 列 A | 列 B |", "| --- | --- |", "| a | b |", "");
  lines.push("## 尾部小节", "", tail);
  return lines.join("\n");
}

function element(text) {
  // 每次渲染都传新的回调实例：块级 memo 不应该因为上游回调换身份而失效。
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(MarkdownBody, { isStreaming: true, cwd: "/tmp", onOpenFile() {} }, text),
  );
}

test("首次渲染按块解析全文", () => {
  const text = blockDocument("尾部段落。");
  render(element(text));

  const { blocks } = splitStreamingMarkdown(text);
  assert.ok(blocks.length >= 10, `块数量过少：${blocks.length}`);
  // 每个冻结块一次，加上尾部块。
  assert.equal(globalThis.__reactMarkdownParseCount, blocks.length + 1);
});

test("流式增长时只重新解析尾部块", () => {
  const { rerender } = render(element(blockDocument("尾部段落第一版。")));
  assert.ok(globalThis.__reactMarkdownParseCount > 10, `首次渲染解析块数异常：${globalThis.__reactMarkdownParseCount}`);

  globalThis.__reactMarkdownParseCount = 0;
  rerender(element(blockDocument("尾部段落第二版，多写了几个字。")));

  assert.equal(globalThis.__reactMarkdownParseCount, 1, "只有尾部块应该被重新解析");
});

test("尾部冻成新块时只解析新尾块", () => {
  const { rerender } = render(element(blockDocument("尾部段落。")));
  const frozenBlocks = globalThis.__reactMarkdownParseCount;

  globalThis.__reactMarkdownParseCount = 0;
  rerender(element(blockDocument("尾部段落。\n\n新增的一段说明文字。")));

  // 尾部段落连同它后面的空行冻结成新块，再加上新的尾部块，共两次。
  assert.equal(globalThis.__reactMarkdownParseCount, 2, "旧块不应重新解析");
  assert.ok(frozenBlocks > 10, `首次渲染解析块数异常：${frozenBlocks}`);
});
