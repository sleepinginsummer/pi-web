import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { withSessionReloadWriteGuard } = await createJiti(import.meta.url).import("./session-reload-write-guard.ts");

class Manager {
  records = [];
  appendCustomEntry(type, data) { this.records.push({ type, data }); return "entry"; }
}

test("公开追加入口在实际调用时校验，SDK 吞掉冲突也必须令重载失败并恢复原方法", async () => {
  const manager = new Manager();
  manager.appendMessage = function (message) { this.records.push({ message }); };
  const custom = manager.appendCustomEntry;
  const message = manager.appendMessage;
  const descriptor = Object.getOwnPropertyDescriptor(manager, "appendMessage");
  const conflict = new Error("模拟磁盘冲突");
  let writable = true;
  await assert.rejects(withSessionReloadWriteGuard(manager, () => { if (!writable) throw conflict; }, async () => {
    assert.equal(manager.appendCustomEntry("first", {}), "entry");
    await Promise.resolve();
    writable = false;
    // 模拟 SDK 的钩子分发器捕获异常后继续执行。
    assert.throws(() => manager.appendCustomEntry("blocked", {}), error => error === conflict);
    assert.throws(() => manager.appendMessage("blocked"), error => error === conflict);
  }), error => error === conflict);
  assert.deepEqual(manager.records, [{ type: "first", data: {} }]);
  assert.strictEqual(manager.appendCustomEntry, custom);
  assert.equal(Object.hasOwn(manager, "appendCustomEntry"), false);
  assert.strictEqual(manager.appendMessage, message);
  assert.deepEqual(Object.getOwnPropertyDescriptor(manager, "appendMessage"), descriptor);
});

test("SDK 本身抛错时仍恢复方法，不将普通错误改写为冲突", async () => {
  const manager = new Manager();
  const custom = manager.appendCustomEntry;
  const sdkError = new Error("模拟 SDK 错误");
  await assert.rejects(withSessionReloadWriteGuard(manager, () => {}, async () => {
    manager.appendCustomEntry("valid", {});
    throw sdkError;
  }), error => error === sdkError);
  assert.strictEqual(manager.appendCustomEntry, custom);
  assert.equal(Object.hasOwn(manager, "appendCustomEntry"), false);
});

test("重载中重新包装的追加方法不会被覆盖，遗留守卫在重载后不再拦截", async () => {
  const manager = new Manager();
  let checks = 0;
  let replacement;
  assert.equal(await withSessionReloadWriteGuard(manager, () => { checks += 1; }, async () => {
    const guarded = manager.appendCustomEntry;
    replacement = function (...args) { return guarded.apply(this, args); };
    manager.appendCustomEntry = replacement;
    return 42;
  }), 42);
  assert.strictEqual(manager.appendCustomEntry, replacement);
  manager.appendCustomEntry("after", {});
  assert.equal(checks, 0);
  assert.deepEqual(manager.records, [{ type: "after", data: {} }]);
});
