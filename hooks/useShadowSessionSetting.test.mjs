import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useShadowSessionSetting } = await jiti.import("./useShadowSessionSetting.ts");
const state = (enabled, extra = {}) => ({ sessionId: "a", shadowMindEnabled: enabled, shadowMindAvailable: true, ...extra });
function setup() {
  const sessionIdRef = { current: "a" };
  const view = renderHook(() => useShadowSessionSetting({ sessionIdRef, staged: null, addErrorNotice: assert.fail }));
  return { view, sessionIdRef };
}

test("关闭的历史会话在无 runtime 和冷启动期间始终显示关闭", () => {
  const { view } = setup();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, false);
  view.result.restoreSnapshot("a", false);
  view.result.applyRuntimeState(undefined);
  view.flush();
  assert.equal(view.result.enabled, false);
  view.result.applyRuntimeState(state(true, { extensionsInitializing: true }));
  view.flush();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, false);
  view.result.applyRuntimeState(state(false, { extensionsInitializing: false }));
  view.flush();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, true);
});

test("开启的历史会话也恢复原值，初始化默认值不能覆盖历史", () => {
  const { view } = setup();
  view.result.restoreSnapshot("a", true);
  view.result.applyRuntimeState(state(false, { extensionsInitializing: true }));
  view.flush();
  assert.equal(view.result.enabled, true);
  assert.equal(view.result.available, false);
});

test("已就绪的 runtime 与 SSE 优先于延迟的历史响应", () => {
  const { view } = setup();
  view.result.applyRuntimeState(state(false));
  view.result.restoreSnapshot("a", true);
  view.flush();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, true);
  view.result.consumeEntry({ type: "custom", customType: "pi-web-shadow-mind-state", data: { enabled: true } });
  view.result.restoreSnapshot("a", false);
  view.flush();
  assert.equal(view.result.enabled, true);
});

test("切换会话立即隔离旧值，旧会话的历史和 runtime 响应不能污染新会话", () => {
  const { view, sessionIdRef } = setup();
  view.result.applyRuntimeState(state(true));
  view.flush();
  sessionIdRef.current = "b";
  view.rerender();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, false);
  view.result.restoreSnapshot("b", false);
  view.result.restoreSnapshot("a", true);
  view.result.applyRuntimeState(state(true));
  view.flush();
  assert.equal(view.result.enabled, false);
  assert.equal(view.result.available, false);
});

test("用户切换成功后不被旧历史覆盖", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: { enabled: true } }));
  const { view } = setup();
  view.result.applyRuntimeState(state(false));
  view.flush();
  await view.result.toggle();
  view.result.restoreSnapshot("a", false);
  view.flush();
  assert.equal(view.result.enabled, true);
  assert.equal(view.result.pending, false);
});
