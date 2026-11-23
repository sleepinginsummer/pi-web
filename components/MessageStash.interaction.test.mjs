import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  Node: { configurable: true, value: dom.window.Node },
  innerWidth: { configurable: true, value: 1280 },
  innerHeight: { configurable: true, value: 800 },
});
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MessageStash } = await jiti.import("./MessageStash.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
afterEach(cleanup);

async function openStash(t, options = {}) {
  let item = { id: "one", revision: "1", preview: "示例正文", imageCount: 0, mode: "steer", status: "ready", ...options.item };
  const requests = [];
  let version = 1;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.action === "list") return Response.json({ items: item ? [item] : [], schedulingEnabled: options.schedulingEnabled ?? true });
    if (options.failAction === body.action) return Response.json({ error: "Draft changed" }, { status: 409 });
    if (body.action === "claim") return Response.json({ token: "claim-token", draft: { text: item.preview, images: [] } });
    if (body.action === "finish") { if (body.sent) item = null; return Response.json({ success: true }); }
    assert.equal(body.revision, item.revision);
    if (body.action === "setMode") item.mode = body.mode;
    if (body.action === "schedule") item.schedule = { at: body.at, sessionId: body.sessionId, label: body.label };
    if (body.action === "cancelSchedule") item.schedule = undefined;
    item.revision = String(++version);
    return Response.json({ success: true });
  });
  const sent = [];
  const props = {
    cwd: "/repo", mobile: false, hasDraft: true, session: { id: "target", label: "目标会话" }, sendMode: "running",
    onSaveDraft: async () => {}, onSendDraft: async (draft, mode) => { sent.push({ draft, mode }); return true; },
    ...options.props,
  };
  const view = render(React.createElement(I18nProvider, null, React.createElement(MessageStash, props)));
  fireEvent.click(view.getByRole("button", { name: "Message stash" }));
  await view.findByText("示例正文");
  await waitFor(() => assert.equal(view.getByRole("radio", { name: "Steer" }).disabled, false));
  return { view, requests, sent };
}

function futureTime() {
  const date = new Date(Date.now() + 3600_000);
  return new Date(date - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

test("卡片直接保存类型，运行中从更多菜单按已选类型发送", async (t) => {
  const { view, requests, sent } = await openStash(t);
  const radio = view.getByRole("radio", { name: "Follow-up" });
  fireEvent.click(radio);
  await waitFor(() => assert.equal(radio.checked, true));
  await waitFor(() => assert.equal(radio.disabled, false));
  assert.equal(requests.find(x => x.action === "setMode").mode, "followUp");
  const menu = view.getByLabelText("Message actions");
  menu.parentElement.open = true;
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].mode, "followUp");
  assert.equal(requests.filter(x => x.action === "claim").length, 1);
  await waitFor(() => assert.equal(requests.filter(x => x.action === "finish").length, 1));
});

test("定时开关直接启停，日期在同一行且编辑完成才改期", async (t) => {
  const { view, requests } = await openStash(t);
  const toggle = view.getByRole("switch", { name: "Schedule" });
  const time = view.getByLabelText("Send at");
  assert.equal(time.type, "datetime-local");
  assert.equal(time.disabled, true);
  assert.equal(time.parentElement, toggle.closest(".stash-card-controls"));
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(time.disabled, false));
  assert.equal(requests.filter(x => x.action === "schedule").length, 1);
  const value = futureTime();
  fireEvent.change(time, { target: { value } });
  assert.equal(requests.filter(x => x.action === "schedule").length, 1);
  fireEvent.blur(time);
  await waitFor(() => assert.equal(requests.filter(x => x.action === "schedule").length, 2));
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(requests.filter(x => x.action === "schedule")[1].at, new Date(value).getTime());
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.checked, false));
  assert.equal(time.disabled, true);
  assert.equal(requests.filter(x => x.action === "cancelSchedule").length, 1);
});

test("日期无效时不发改期请求，关定时不会被输入框失焦抢先阻断", async (t) => {
  const { view, requests } = await openStash(t, { item: { schedule: { at: Date.now() + 600_000, sessionId: "original", label: "原会话" } } });
  const time = view.getByLabelText("Send at");
  fireEvent.change(time, { target: { value: "" } });
  fireEvent.blur(time);
  await view.findByRole("alert");
  assert.equal(requests.some(x => x.action === "schedule"), false);
  fireEvent.change(time, { target: { value: futureTime() } });
  const toggle = view.getByRole("switch", { name: "Schedule" });
  fireEvent.blur(time, { relatedTarget: toggle });
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.checked, false));
  assert.equal(requests.some(x => x.action === "schedule"), false);
  assert.equal(requests.filter(x => x.action === "cancelSchedule").length, 1);
});

test("服务端拒绝改类型时保留原选择", async (t) => {
  const { view } = await openStash(t, { failAction: "setMode" });
  fireEvent.click(view.getByRole("radio", { name: "Follow-up" }));
  await view.findByRole("alert");
  await waitFor(() => assert.equal(view.getByRole("radio", { name: "Steer" }).checked, true));
});

test("空闲发送沿用普通发送入口，无目标会话时禁用新定时", async (t) => {
  const { view, sent } = await openStash(t, { props: { sendMode: "idle", session: undefined } });
  assert.equal(view.getByRole("switch").disabled, true);
  view.getByLabelText("Message actions").parentElement.open = true;
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.equal(sent[0]?.mode, "send"));
});
