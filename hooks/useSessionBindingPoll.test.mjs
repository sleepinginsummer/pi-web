import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSerialPoller, SESSION_BINDING_DEADLINE_MS, SESSION_BINDING_POLL_INTERVAL_MS } = await jiti.import("./useSessionBindingPoll.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  const box = {};
  box.promise = new Promise((resolve, reject) => { box.resolve = resolve; box.reject = reject; });
  return box;
};

test("上一次读取未返回时不发第二次请求", async (t) => {
  const pendingCalls = [];
  const poller = createSerialPoller({
    intervalMs: 5,
    read: () => { const call = deferred(); pendingCalls.push(call); return call.promise; },
    onResult: () => {},
  });
  t.after(() => poller.stop());
  poller.start();

  await wait(40);
  assert.equal(pendingCalls.length, 1, "在途请求未结束前不能叠加新请求");

  pendingCalls[0].resolve("ready");
  await wait(20);
  assert.equal(pendingCalls.length, 2, "前一次返回后才排下一次");

  pendingCalls[1].resolve("ready");
});

test("stop 会取消在途读取并停止后续调度", async (t) => {
  const pending = deferred();
  const calls = [];
  const results = [];
  const poller = createSerialPoller({
    intervalMs: 5,
    read: (signal) => { calls.push(signal); return pending.promise; },
    onResult: (value) => results.push(value),
  });
  t.after(() => poller.stop());
  poller.start();
  await wait(15);

  poller.stop();
  assert.equal(calls[0].aborted, true, "在途读取必须被取消");

  pending.resolve("late");
  await wait(20);
  assert.equal(calls.length, 1, "stop 之后不再调度");
  assert.deepEqual(results, [], "停止后到达的结果不得再回调");
});

test("读取失败不会中断轮询，也不会误报成功", async (t) => {
  let attempts = 0;
  const results = [];
  const errors = [];
  const poller = createSerialPoller({
    intervalMs: 5,
    read: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("blocked");
      return "ready";
    },
    onResult: (value) => results.push(value),
    onError: (error) => errors.push(String(error)),
  });
  t.after(() => poller.stop());
  poller.start();

  await wait(20);
  poller.stop();
  assert.equal(attempts >= 2, true, "失败后仍要继续兜底轮询");
  assert.equal(results.length >= 1, true, "成功的一次必须回调");
  assert.equal(results.every((value) => value === "ready"), true);
  assert.deepEqual(errors, ["Error: blocked"]);
});

test("兜底轮询间隔是 3 秒，快路径仍是绑定完成事件", () => {
  assert.equal(SESSION_BINDING_POLL_INTERVAL_MS, 3_000);
});

test("绑定永不结束时会到期收敛，而不是永久等待", async () => {
  const poller = createSerialPoller({
    intervalMs: 5,
    deadlineMs: 25,
    read: () => new Promise(() => {}),
    onResult: () => {},
    onDeadline: () => { deadlines += 1; },
  });
  let deadlines = 0;
  poller.start();
  await wait(60);
  assert.equal(deadlines, 1, "到期只回调一次");

  // 到期后不再有在途读取，界面可以带着同一身份走重试路径。
  await wait(30);
  assert.equal(deadlines, 1);
  poller.stop();
});

test("等待期限是 60 秒（服务端的 20s 只是单条命令的等待）", () => {
  assert.equal(SESSION_BINDING_DEADLINE_MS, 60_000);
});
