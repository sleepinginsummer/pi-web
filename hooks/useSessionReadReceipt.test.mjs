import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { renderHook } from "./__fixtures__/react-hook-shim.mjs";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { react: fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url)) },
});
const { useSessionReadReceipt } = await jiti.import("./useSessionReadReceipt.ts");
const { withoutReadMarks } = await jiti.import("../lib/unread-markers.ts");

test("当前会话每轮结束后上报已读，失焦时留到重新关注页面再上报", async (t) => {
  const window = new EventTarget();
  let focused = true;
  globalThis.window = window;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  let hook;
  t.after(() => {
    hook?.unmount();
    delete globalThis.window;
    delete globalThis.document;
  });
  const posts = [];
  const reads = [100, 200, 300];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/sessions/current/read");
    assert.equal(options.method, "POST");
    const readAt = reads[posts.length];
    assert.ok(readAt, "同一轮不得重复上报");
    posts.push(readAt);
    return Response.json({ readAt });
  });

  const initial = { running: false, modified: new Date(50).toISOString(), readAt: undefined };
  hook = renderHook(({ running, modified, readAt }) => {
    useSessionReadReceipt("current", running, modified, readAt, undefined);
  }, initial);
  assert.deepEqual(posts, []);
  window.dispatchEvent(new Event("pointerdown"));
  await setImmediate();
  assert.deepEqual(posts, [100]);

  hook.rerender({ ...initial, running: true, readAt: 100 });
  assert.deepEqual(posts, [100]);
  hook.rerender({ ...initial, readAt: 100 });
  assert.deepEqual(posts, [100, 200], "会话的 modified 未更新也要为新一轮上报");
  hook.rerender({ ...initial, modified: new Date(190).toISOString(), readAt: 100 });
  await setImmediate();
  hook.rerender({ ...initial, modified: new Date(190).toISOString(), readAt: 200 });
  assert.deepEqual(posts, [100, 200], "目录刷新和轮询回执不得再次上报同一轮");
  assert.deepEqual([...withoutReadMarks(new Map([["current", 150]]), { current: posts.at(-1) })], [],
    "浏览器 B 收到新回执后能清除这一轮的未读标记");

  hook.rerender({ ...initial, running: true, readAt: 200 });
  focused = false;
  window.dispatchEvent(new Event("blur"));
  hook.rerender({ ...initial, readAt: 200 });
  assert.deepEqual(posts, [100, 200]);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  await setImmediate();
  assert.deepEqual(posts, [100, 200, 300]);
});
