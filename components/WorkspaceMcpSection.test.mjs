import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { WorkspaceMcpSection } = await jiti.import("./WorkspaceMcpSection.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

async function setup(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const requests = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url) => new Promise((resolve) => requests.push({ url, resolve })),
  };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.querySelector("#root");
  const root = createRoot(container);
  t.after(async () => {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  const render = async (sessionId) => React.act(() => root.render(
    React.createElement(I18nProvider, null, React.createElement(WorkspaceMcpSection, { key: sessionId ?? "new", sessionId })),
  ));
  const respond = async (request, body, ok = true) => React.act(async () => {
    request.resolve({ ok, status: ok ? 200 : 500, json: async () => body });
  });
  const expand = async () => React.act(() => container.querySelector(".workspace-hud-sec-header").click());
  return { container, requests, render, respond, expand };
}

test("MCP 栏目展开显示当前会话连接和各自状态", async (t) => {
  const { container, requests, render, respond, expand } = await setup(t);
  await render("session-a");
  assert.equal(requests[0].url, "/api/agent/session-a?view=mcp");
  await respond(requests[0], { sessionId: "session-a", live: true, servers: [
    { name: "docs", scope: "global", state: "ready" },
    { name: "search", scope: "project", state: "connecting" },
    { name: "auth", scope: "global", state: "needs-auth" },
    { name: "broken", scope: "global", state: "failed" },
  ] });
  assert.equal(container.querySelector(".workspace-hud-count").textContent, "4");
  const header = container.querySelector(".workspace-hud-sec-header");
  assert.ok(header.querySelector("svg"));
  assert.equal(header.textContent.includes("MCP"), false);
  assert.equal(header.getAttribute("aria-label"), "MCP 4");
  assert.equal(container.querySelector(".workspace-hud-sec-list"), null);
  await expand();
  assert.equal(container.querySelector("[aria-expanded]").getAttribute("aria-expanded"), "true");
  assert.equal(container.querySelectorAll(".workspace-hud-row").length, 4);
  assert.match(container.textContent, /docsConnected/);
  assert.match(container.textContent, /searchConnecting/);
  assert.match(container.textContent, /authNeeds sign-in/);
  assert.match(container.textContent, /brokenDid not connect/);
});

test("切换会话立即清空旧列表，迟到响应不覆盖新会话", async (t) => {
  const { container, requests, render, respond, expand } = await setup(t);
  await render("session-a");
  await render("session-b");
  await respond(requests[1], { sessionId: "session-b", live: true, servers: [{ name: "only-b", scope: "project", state: "ready" }] });
  await expand();
  await respond(requests[0], { sessionId: "session-a", live: true, servers: [{ name: "only-a", scope: "global", state: "ready" }] });
  assert.match(container.textContent, /only-b/);
  assert.doesNotMatch(container.textContent, /only-a/);
  await render(null);
  await expand();
  assert.equal(requests.length, 2);
  assert.doesNotMatch(container.textContent, /only-b/);
  assert.match(container.textContent, /No MCP connections/);
});

test("读取失败可重试，已回收会话显示无连接且不重启", async (t) => {
  const { container, requests, render, respond, expand } = await setup(t);
  await render("session-a");
  await respond(requests[0], { error: "read failed" }, false);
  await expand();
  assert.match(container.textContent, /Could not read MCP status/);
  await React.act(() => container.querySelector(".workspace-hud-mini-btn").click());
  await respond(requests[1], { sessionId: "session-a", live: false, servers: [] });
  assert.match(container.textContent, /Session is not running/);
  assert.equal(container.querySelector("[role=alert]"), null);
});
