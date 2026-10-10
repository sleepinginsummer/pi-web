import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { NewSessionOperationRegistry } = await jiti.import("./new-session-operation-registry.ts");

const deferred = () => {
  const box = {};
  box.promise = new Promise((resolve, reject) => { box.resolve = resolve; box.reject = reject; });
  return box;
};

test("创建尚未返回时第二次请求只调用一次 factory，两次取得同一 sessionId", async () => {
  const registry = new NewSessionOperationRegistry(new Map());
  const pending = deferred();
  let factoryCalls = 0;
  const create = () => { factoryCalls += 1; return pending.promise; };

  const first = registry.getOrCreate("op-1", "/tmp/a", create);
  const second = registry.getOrCreate("op-1", "/tmp/a", create);
  assert.equal(factoryCalls, 1, "并发请求必须共享同一次创建");

  pending.resolve("session-a");
  assert.deepEqual(await Promise.all([first, second]), ["session-a", "session-a"]);
  assert.equal(registry.peekDelivered("op-1", "/tmp/a"), "session-a");
  assert.equal(factoryCalls, 1);
});

test("cwd 不一致时拒绝复用同一创建意图", async () => {
  const registry = new NewSessionOperationRegistry(new Map());
  await registry.getOrCreate("op-1", "/tmp/a", async () => "session-a");
  await assert.rejects(
    registry.getOrCreate("op-1", "/tmp/b", async () => "session-b"),
    /cwd 不匹配/,
  );
  assert.equal(registry.peekDelivered("op-1", "/tmp/b"), undefined);
});

test("创建失败后按身份清理，重试可以重新创建", async () => {
  const registry = new NewSessionOperationRegistry(new Map());
  await assert.rejects(registry.getOrCreate("op-1", "/tmp/a", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(registry.peekDelivered("op-1", "/tmp/a"), undefined);
  assert.equal(await registry.getOrCreate("op-1", "/tmp/a", async () => "session-a"), "session-a");
});

test("终态后可以显式遗忘该操作", async () => {
  const registry = new NewSessionOperationRegistry(new Map());
  await registry.getOrCreate("op-1", "/tmp/a", async () => "session-a");
  registry.forget("op-1");
  assert.equal(registry.peekDelivered("op-1", "/tmp/a"), undefined);
  assert.equal(registry.size, 0);
});

test("交付的 runtime 已不可用时必须清条目，重试才会重新创建", async () => {
  const registry = new NewSessionOperationRegistry(new Map());
  let factoryCalls = 0;
  const create = async () => { factoryCalls += 1; return "session-a"; };

  assert.equal(await registry.getOrCreate("op-1", "/tmp/a", create), "session-a");
  registry.forgetIfUnusable("op-1", "/tmp/a", () => true);
  assert.equal(registry.peekDelivered("op-1", "/tmp/a"), "session-a", "仍然可用时不得丢弃");

  registry.forgetIfUnusable("op-1", "/tmp/a", () => false);
  assert.equal(registry.peekDelivered("op-1", "/tmp/a"), undefined);
  assert.equal(await registry.getOrCreate("op-1", "/tmp/a", create), "session-a");
  assert.equal(factoryCalls, 2, "回收后重试必须重新创建，而不是复用死掉的 runtime");
});

test("跨模块代际复用同一份数据，逻辑来自当前实现", async () => {
  // 模拟 HMR：globalThis 上只有纯数据表，新实例包装它并用自己的逻辑继续服务。
  const shared = new Map();
  const previous = new NewSessionOperationRegistry(shared);
  await previous.getOrCreate("op-1", "/tmp/a", async () => "session-a");

  const current = new NewSessionOperationRegistry(shared);
  assert.equal(current.peekDelivered("op-1", "/tmp/a"), "session-a");
  assert.equal(
    await current.getOrCreate("op-1", "/tmp/a", async () => { throw new Error("不得重新创建"); }),
    "session-a",
    "在途/已交付意图必须跨代际继续复用",
  );
});
