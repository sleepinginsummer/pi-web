import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

registerHooks({ load(url, context, next) {
  if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  return next(url, context);
} });
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator }, HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Element: { configurable: true, value: dom.window.Element }, Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const originalFetch = globalThis.fetch;
let completeMountResponses;
const mountResponses = new Promise((resolve) => { completeMountResponses = resolve; });
globalThis.fetch = async (url) => {
  await mountResponses;
  const data = String(url).includes("/api/thinking-level-preferences")
    ? { thinkingLevel: "medium" }
    : { models: { "fixture:fixture": "Fixture" }, modelList: [{ provider: "fixture", id: "fixture", name: "Fixture", fastAvailable: false }], defaultModel: { provider: "fixture", modelId: "fixture" }, defaultThinkingLevel: "medium", thinkingLevels: { "fixture:fixture": ["off", "low", "medium", "high"] }, thinkingLevelMaps: {}, thinkingLevelPins: {}, modelScopeWarnings: [], providers: [], commands: [] };
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
};
const { render, cleanup } = await import("@testing-library/react");
const actual = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const hookSource = (await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8"))
  .replace("handleAgentEventRef.current = handleAgentEvent;", "handleAgentEventRef.current = handleAgentEvent; globalThis.__streamRenderProbe.handleEvent = handleAgentEvent;");
const mountLoadStatement = "void retryModelLoad(loadModels, controller.signal, delay);";
assert.ok(hookSource.includes(mountLoadStatement), "挂载加载探针必须命中真实加载任务");
const instrumentedHookSource = hookSource.replace(mountLoadStatement, "globalThis.__streamRenderProbe.mountLoad = retryModelLoad(loadModels, controller.signal, delay);");
const { useAgentSession } = actual.evalModule(instrumentedHookSource, { filename: new URL("../hooks/useAgentSession.streaming-probe.ts", import.meta.url).pathname });
const { ChatInput } = await actual.import("./ChatInput.tsx");
const { StreamingReply } = await actual.import("./StreamingReply.tsx");
const { I18nProvider } = await actual.import("../hooks/useI18n.tsx");
const { createStreamingStore } = await actual.import("../lib/streaming-message.ts");
const { useStreamingSelector, selectStreamingMessage } = await actual.import("../hooks/useStreamingSelector.ts");
const { useFrameBatchedStreamDispatch } = await actual.import("../hooks/useFrameBatchedStreamDispatch.ts");
const fixtures = await mkdtemp(join(tmpdir(), "pi-stream-render-"));
// 只插入计数探针，hook 和输入框均执行生产实现。
globalThis.__streamRenderProbe = { useAgentSession, ChatInput, StreamingReply, React, windowRenders: 0, inputCommits: 0, replyCommits: 0, result: null };
await writeFile(join(fixtures, "session.mjs"), `export function useAgentSession(opts) { const p=globalThis.__streamRenderProbe; p.windowRenders++; return p.result=p.useAgentSession(opts); }`);
await writeFile(join(fixtures, "input.mjs"), `const p=globalThis.__streamRenderProbe; export const ChatInput=p.React.forwardRef((props,ref)=>p.React.createElement(p.React.Profiler,{id:'input',onRender:()=>p.inputCommits++},p.React.createElement(p.ChatInput,{...props,ref})));`);
await writeFile(join(fixtures, "reply.mjs"), `const p=globalThis.__streamRenderProbe; export const StreamingReply=(props)=>{ p.replyStore=props.store; return p.React.createElement(p.React.Profiler,{id:'reply',onRender:()=>p.replyCommits++},p.React.createElement(p.StreamingReply,props)); };`);
const instrumented = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
});
const source = (await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"))
  .replace('from "@/hooks/useAgentSession"', `from "${join(fixtures, "session.mjs")}"`)
  .replace('from "./StreamingReply"', `from "${join(fixtures, "reply.mjs")}"`)
  .replace('from "./ChatInput"', `from "${join(fixtures, "input.mjs")}"`);
const { ChatWindow } = instrumented.evalModule(source, { filename: new URL("./ChatWindow.streaming-probe.tsx", import.meta.url).pathname });
afterEach(() => { cleanup(); mock.timers.reset(); frames.clear(); });
after(async () => { cleanup(); globalThis.fetch = originalFetch; delete globalThis.__streamRenderProbe; dom.window.close(); await rm(fixtures, { recursive: true, force: true }); });

const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: "fixture", model: "fixture", timestamp: 1 });

test("正文增量只提交回复：真实 ChatWindow/useAgentSession 与 ChatInput 不按 chunk 重渲", { timeout: 10_000 }, async () => {
  // 隔离滚动校正和回复时钟的独立更新，只计量 SSE 增量导致的渲染。
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = render(React.createElement(I18nProvider, null, React.createElement(ChatWindow, { session: null, navigationKey: 1, newSessionCwd: "/fixture", newSessionWorktrees: [], pendingNewSessionControl: { kind: "staged", model: null, thinkingLevel: "auto", shadowMindEnabled: false }, onPendingNewSessionEvent() {}, isNavigationActive: () => true, notificationController: { notificationEnabled: false, notifySession() {} } })));
  const probe = globalThis.__streamRenderProbe;
  assert.ok(probe.mountLoad instanceof Promise, "必须等待真实挂载加载任务，而非只清空一次 act");
  let mountLoaded = false;
  void probe.mountLoad.then(() => { mountLoaded = true; });
  await act(async () => {});
  assert.equal(mountLoaded, false, "刻意延迟挂载响应，覆盖响应晚于首次渲染的情况");
  // 释放网络响应后等待完整加载链（包括强度推荐）与 React 提交，再开始 SSE 计数。
  await act(async () => {
    completeMountResponses();
    await probe.mountLoad;
  });
  assert.equal(mountLoaded, true);
  assert.equal(probe.result.modelState.error, null, "挂载必须成功，不能把模型响应解析失败后的重试误当作加载完成");
  assert.equal(probe.result.modelState.thinkingLevel, "medium");
  const store = probe.result.streamingStore;
  assert.ok(store, "必须从真实 useAgentSession 返回外部 store");
  await act(async () => {
    probe.handleEvent({ type: "agent_start" });
    probe.handleEvent({ type: "message_start", message: assistant("begin") });
  });
  const baseline = { window: probe.windowRenders, input: probe.inputCommits, reply: probe.replyCommits };
  assert.ok(baseline.window > 0 && baseline.input > 0, "计数探针必须覆盖真实窗口和输入框");
  for (let i = 0; i < 30; i++) {
    await act(async () => {
      probe.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `-${i}` } });
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    });
  }
  assert.match(store.getState().streamingMessage.content[0].text, /begin-0-1/);
  assert.equal(probe.windowRenders, baseline.window);
  assert.equal(probe.inputCommits, baseline.input);
  assert.ok(probe.replyCommits - baseline.reply >= 30, "每个增量都提交回复；回复自己的计时器可额外提交");
  assert.match(view.container.textContent, /begin-0-1/);
  assert.match(view.container.textContent, /-29/);
  console.log(`StreamingStore render counts: 30 chunks, reply +${probe.replyCommits - baseline.reply}, ChatWindow +${probe.windowRenders - baseline.window}, ChatInput +${probe.inputCommits - baseline.input}`);
  const beforeEnd = [];
  const unsubscribe = store.subscribe(() => beforeEnd.push(store.getState().streamingMessage?.content[0]?.text));
  const completed = assistant(store.getState().streamingMessage.content[0].text + "-flushed");
  await act(async () => {
    probe.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "-flushed" } });
    // 不执行动画帧：真实 message_end 必须同步 flush 后，再追加权威消息并结束 store。
    probe.handleEvent({ type: "message_end", message: completed });
  });
  assert.equal(beforeEnd[0], completed.content[0].text);
  assert.equal(store.getState().isStreaming, false);
  assert.equal(probe.result.messages.at(-1).content[0].text, completed.content[0].text);
  assert.equal(view.container.textContent.split(completed.content[0].text).length - 1, 1, "完成消息只出现一次");
  unsubscribe();
  // 旧服务端可能只发累积快照：首个快照清掉 waiting_model，后续正文仍只更新回复。
  await act(async () => { probe.handleEvent({ type: "message_update", message: assistant("legacy") }); });
  assert.equal(probe.result.agentPhase, null);
  const legacyBaseline = { window: probe.windowRenders, input: probe.inputCommits };
  await act(async () => { probe.handleEvent({ type: "message_update", message: assistant("legacy updated") }); });
  assert.equal(probe.windowRenders, legacyBaseline.window);
  assert.equal(probe.inputCommits, legacyBaseline.input);
  assert.match(view.container.textContent, /legacy updated/);
  view.unmount();
});

test("按帧增量保持顺序，message_end 前同步 flush，切换会话丢弃旧帧", async () => {
  const store = createStreamingStore();
  let controls;
  function Harness({ sid }) {
    controls = useFrameBatchedStreamDispatch((events) => store.dispatch({ type: "delta_batch", events }), sid);
    const message = useStreamingSelector(store, selectStreamingMessage);
    return React.createElement("div", null, message?.content[0]?.text ?? "");
  }
  const view = render(React.createElement(Harness, { sid: "a" }));
  await act(async () => { store.dispatch({ type: "snapshot", message: assistant("") }); });
  controls.enqueue({ type: "text_delta", contentIndex: 0, delta: "a" });
  controls.enqueue({ type: "text_delta", contentIndex: 0, delta: "b" });
  assert.equal(view.container.textContent, "");
  await act(async () => { controls.flush(); });
  assert.equal(view.container.textContent, "ab");
  controls.enqueue({ type: "text_delta", contentIndex: 0, delta: "discard" });
  view.rerender(React.createElement(Harness, { sid: "b" }));
  await act(async () => { store.dispatch({ type: "end" }); store.dispatch({ type: "snapshot", message: assistant("new") }); });
  await act(async () => { for (const callback of [...frames.values()]) callback(); frames.clear(); });
  assert.equal(view.container.textContent, "new");
  view.unmount();
});
