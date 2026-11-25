import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProjectMark } = await jiti.import("./ProjectMark.tsx");
const { projectBadge } = await jiti.import("@/lib/project-badge");

afterEach(cleanup);

const markOf = (path) => render(React.createElement(ProjectMark, { path, name: "pi-web" })).container.querySelector("[data-session-project-mark]");

// jsdom 把内联颜色归一成 rgb()，这里用同样的形式比较。
const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};

test("图标返回之前先显示色块首字，不会空出一格", () => {
  const path = "/repo/无图标的项目";
  const mark = markOf(path);
  assert.ok(mark);
  assert.equal(mark.getAttribute("data-session-project-mark"), "letter");
  assert.equal(mark.textContent, "P");
  assert.equal(mark.style.background, rgb(projectBadge(path, "pi-web").background));
  // 首字占位期间图片已在加载，加载成功后由它取代首字。
  assert.equal(mark.querySelector("img")?.getAttribute("src"), `/api/project-icon?${new URLSearchParams({ project: path }).toString()}`);
});

test("项目自带图标加载成功后改用图标", () => {
  const mark = markOf("/repo/自带图标");
  fireEvent.load(mark.querySelector("img"));
  assert.equal(mark.getAttribute("data-session-project-mark"), "icon");
  assert.equal(mark.textContent, "");
  assert.equal(mark.querySelector("img").style.opacity, "1");
});

test("没有图标时回落到字母标记，并且不再重复请求同一个目录", () => {
  const mark = markOf("/repo/没有图标");
  fireEvent.error(mark.querySelector("img"));
  assert.equal(mark.getAttribute("data-session-project-mark"), "letter");
  assert.equal(mark.textContent, projectBadge("/repo/没有图标", "pi-web").initial);
  cleanup();

  const again = markOf("/repo/没有图标");
  assert.equal(again.querySelector("img"), null);
  assert.equal(again.getAttribute("data-session-project-mark"), "letter");
});
