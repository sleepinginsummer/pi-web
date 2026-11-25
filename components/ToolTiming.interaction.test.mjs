import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator }, HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});
const { render, act, cleanup } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MessageView } = await jiti.import("./MessageView.tsx");
const { CodemodeCallList } = await jiti.import("./CodemodeToolView.tsx");
const { ToolTiming } = await jiti.import("./ToolTiming.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { formatToolStartedAt } = await jiti.import("../lib/tool-timing.ts");
afterEach(cleanup);
const h = React.createElement;
const wrap = (node) => h(I18nProvider, null, node);
function clock(t) {
  let wall = 1_700_000_000_000, mono = 100;
  const callbacks = new Set();
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => mono);
  t.mock.method(window, "setInterval", (callback) => { callbacks.add(callback); return callback; });
  t.mock.method(window, "clearInterval", (callback) => callbacks.delete(callback));
  return { get wall() { return wall; }, get mono() { return mono; },
    tick(ms) { wall += ms; mono += ms; act(() => { for (const callback of [...callbacks]) callback(); }); } };
}
const texts = (view) => [...view.container.querySelectorAll("[data-tool-timing]")].map((node) => node.textContent);

test("工具出现立即有开始时间与0.0s，并行 bash 各自计时；部分输出不能盖掉实时计时", (t) => {
  const c = clock(t), startedAt = c.wall;
  const message = { role: "assistant", timestamp: startedAt - 60000, content: ["a", "b"].map((id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: { command: id } })) };
  const clocks = new Map([["a", { startedAt: c.mono, wallStartedAt: startedAt }], ["b", { startedAt: c.mono, wallStartedAt: startedAt }]]);
  const view = render(wrap(h(MessageView, { message, toolClocks: clocks })));
  const initial = `${formatToolStartedAt(startedAt)} · 0.0s`;
  assert.deepEqual(texts(view), [initial, initial]);
  c.tick(2500);
  assert.deepEqual(texts(view), [initial.replace("0.0s", "2.5s"), initial.replace("0.0s", "2.5s")]);
  const toolResults = new Map([["a", { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "still running" }], timestamp: c.wall, isPartial: true }]]);
  view.rerender(wrap(h(MessageView, { message, toolClocks: clocks, toolResults })));
  c.tick(1000);
  assert.deepEqual(texts(view), [initial.replace("0.0s", "3.5s"), initial.replace("0.0s", "3.5s")]);
  const ended = new Map(clocks);
  ended.set("a", { durationMs: 3500, wallStartedAt: startedAt });
  view.rerender(wrap(h(MessageView, { message, toolClocks: ended, toolResults })));
  c.tick(2000);
  assert.deepEqual(texts(view), [initial.replace("0.0s", "3.5s"), initial.replace("0.0s", "5.5s")]);
});

test("codemode 同名子调用 ID 从占位变为实际值时，其他调用不重置；重新挂载按服务端时间续计", (t) => {
  const c = clock(t), start = c.wall;
  const calls = [0, 1].map(() => ({ id: "parent/?", name: "read", args: "file", status: "running", startedAt: start }));
  const view = render(wrap(h(CodemodeCallList, { calls, omitted: 0, isError: false })));
  c.tick(2000);
  const next = [{ ...calls[0], id: "parent/1", status: "ok", durationMs: 2000 }, calls[1]];
  view.rerender(wrap(h(CodemodeCallList, { calls: next, omitted: 0, isError: false })));
  c.tick(1000);
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 2.0s`, `${formatToolStartedAt(start)} · 3.0s`]);
  view.unmount();
  const reconnected = render(wrap(h(CodemodeCallList, { calls: next, omitted: 0, isError: false })));
  assert.deepEqual(texts(reconnected), [`${formatToolStartedAt(start)} · 2.0s`, `${formatToolStartedAt(start)} · 3.0s`]);
});

test("短 read 完成也显示时间，手动 bash 在等待与完成状态共用同一时间行", (t) => {
  const c = clock(t), start = c.wall;
  const view = render(wrap(h(MessageView, { message: { role: "bashExecution", command: "demo", output: "", isPartial: true, timestamp: start } })));
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 0.0s`]);
  c.tick(2000);
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 2.0s`]);
  view.rerender(wrap(h(MessageView, { message: { role: "bashExecution", command: "demo", output: "ok", exitCode: 0, toolTiming: { startedAt: start, durationMs: 2000 } } })));
  c.tick(3000);
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 2.0s`]);
  view.rerender(wrap(h(ToolTiming, { startedAt: start, durationMs: 40, running: false })));
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 0.0s`]);
});

test("停止和缺失历史计时信息时不会继续增长或编造开始时间", (t) => {
  const c = clock(t), start = c.wall;
  const view = render(wrap(h(ToolTiming, { startedAt: start, running: true })));
  c.tick(1000);
  view.rerender(wrap(h(ToolTiming, { startedAt: start, running: false })));
  c.tick(5000);
  assert.deepEqual(texts(view), [`${formatToolStartedAt(start)} · 1.0s`]);
  view.unmount();
  const history = render(wrap(h(ToolTiming, { running: false })));
  assert.deepEqual(texts(history), ["— · —"]);
});

test("子调用重连时使用服务端耗时，设备时钟差不影响计数", (t) => {
  const c = clock(t);
  const view = render(wrap(h(ToolTiming, { startedAt: c.wall - 60000, elapsedMs: 2500, running: true })));
  assert.match(texts(view)[0], / · 2\.5s$/);
  c.tick(1000);
  assert.match(texts(view)[0], / · 3\.5s$/);
});
