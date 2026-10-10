import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import reactSyntaxHighlighter from "react-syntax-highlighter";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const { Prism: SyntaxHighlighter } = reactSyntaxHighlighter;

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

// 连接生命周期（含 watchEnabled 门控、connected 后补读、额度与可见性）统一在 useFileWatch 里，
// 各预览只声明自己的元数据/校验回调；这里守住"只有一处实现"这条边界。
for (const [name, nextName] of [
  ["ImageViewer", "formatDuration"],
  ["AudioViewer", "VideoViewer"],
  ["VideoViewer", "DocumentViewer"],
  ["DocumentViewer", "FileViewer"],
  ["TextFileViewer", null],
]) {
  test(`${name} delegates its watcher to useFileWatch`, () => {
    const block = functionBlock(name, nextName);
    assert.match(block, /useFileWatch\(\{/, "预览必须使用共享的 watch hook");
    assert.doesNotMatch(block, /new EventSource/, "不得各自建立 watch 连接");
    assert.doesNotMatch(block, /if \(!watchEnabled\) return;/, "watchEnabled 门控已由 hook 统一处理");
  });
}

test("文件 watch 的唯一实现集中在 useFileWatch", async () => {
  const hook = await readFile(new URL("../hooks/useFileWatch.ts", import.meta.url), "utf8");
  assert.equal(hook.match(/createStreamSource\(/g)?.length, 1, "只允许一处建立 watch 连接（经由 broker 门面）");
  assert.doesNotMatch(hook, /new EventSource/, "不得绕过 broker 直接建连");
  assert.match(hook, /if \(!granted \|\| !enabled \|\| visible === false\) return;/);
  assert.match(hook, /const unsubscribe = fileWatchBudget\.subscribe/, "额度变化要通知等待者");
  assert.match(hook, /syncMeta\(\);/, "connected 后补读一次，闭合快照与实时事件的空档");
});

test("FileViewer forwards watcher state to every viewer implementation", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.equal(block.match(/watchEnabled=\{watchEnabled\}/g)?.length, 5);
});

test("TextFileViewer snapshots and restores lightweight tab state", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\)/);
  assert.match(block, /displayMode: requestedInitialDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.displayMode = nextDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.wrapLines = next/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = event\.currentTarget\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = event\.currentTarget\.scrollLeft/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer keeps first-mount preview eligibility across Strict Effects cleanup", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /defaultPreviewEligibleRef = useRef\(/);
  assert.match(block, /defaultPreviewEligibleRef\.current[\s\S]*updateDisplayMode\("preview"\)/);
});

test("markdown table tokens stay inline despite Tailwind's table utility", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.match(html, /class="token table[ "]/);
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});
