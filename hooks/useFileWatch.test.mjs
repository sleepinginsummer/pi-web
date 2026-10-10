import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { FILE_WATCH_BUDGET, FileWatchBudget, shouldHoldFileWatch } = await jiti.import("./useFileWatch.ts");

test("watch 额度按连接实例计数，释放后归还名额", () => {
  const budget = new FileWatchBudget(2);
  assert.equal(budget.request("owner-a"), true);
  assert.equal(budget.request("owner-a"), true, "同一实例重复申请保持幂等");
  assert.equal(budget.size, 1);
  // 同一文件被两个预览实例监听就是两条连接，必须各占一份额度。
  assert.equal(budget.request("owner-b"), true);
  assert.equal(budget.size, 2);

  assert.equal(budget.request("owner-c"), false, "超出额度必须进入等待而不是硬撑连接");
  budget.release("owner-a");
  assert.equal(budget.isHolding("owner-c"), true, "释放的名额应交给等待者");
  budget.release("missing");
  assert.equal(budget.size, 2, "释放不存在的 owner 不应改变额度占用");
});

test("额度满时排队等待，持有者释放后按 FIFO 恢复并通知订阅者", () => {
  const budget = new FileWatchBudget(1);
  let notifications = 0;
  const unsubscribe = budget.subscribe(() => { notifications += 1; });

  assert.equal(budget.request("holder"), true);
  assert.equal(budget.request("waiter-1"), false);
  assert.equal(budget.request("waiter-2"), false);
  assert.equal(budget.isWaiting("waiter-1"), true);
  assert.equal(notifications, 0, "排队本身不算额度变化");

  budget.release("holder");
  assert.equal(budget.isHolding("waiter-1"), true, "先到的等待者先拿到名额");
  assert.equal(notifications, 1, "额度变化必须通知订阅者，让等待的预览重新建立连接");

  // 等待者卸载后必须退出队列，释放的名额不能被已消失的实例占走。
  budget.cancel("waiter-2");
  assert.equal(budget.isWaiting("waiter-2"), false);
  budget.release("waiter-1");
  assert.equal(budget.size, 0);
  unsubscribe();
});

test("一个持有者退出时，其他持有者的额度状态不变（连接不该被重建）", () => {
  const budget = new FileWatchBudget(2);
  assert.equal(budget.request("holder-a"), true);
  assert.equal(budget.request("holder-b"), true);
  assert.equal(budget.request("waiter"), false);

  // hook 的订阅只比较自己的 isHolding：这里模拟它看到的结果序列。
  const snapshots = [];
  const observers = ["holder-a", "holder-b", "waiter"].map((owner) => {
    let granted = budget.isHolding(owner);
    const unsubscribe = budget.subscribe(() => {
      const holding = budget.isHolding(owner);
      if (holding === granted) return;
      granted = holding;
      snapshots.push({ owner, granted });
    });
    return unsubscribe;
  });

  budget.release("holder-a");
  assert.deepEqual(
    snapshots,
    [{ owner: "holder-a", granted: false }, { owner: "waiter", granted: true }],
    "退还者自己与等待者各变一次，仍持有连接的 holder-b 不动",
  );
  for (const unsubscribe of observers) unsubscribe();
});

test("后台标签页不持有 watch 连接", () => {
  assert.equal(shouldHoldFileWatch({ enabled: true, hidden: false, acquired: true }), true);
  assert.equal(shouldHoldFileWatch({ enabled: true, hidden: true, acquired: true }), false);
  assert.equal(shouldHoldFileWatch({ enabled: false, hidden: false, acquired: true }), false);
  assert.equal(shouldHoldFileWatch({ enabled: true, hidden: false, acquired: false }), false);
});

test("额度上限是 3：会话流与全局流之外必须留出余量", () => {
  assert.equal(FILE_WATCH_BUDGET, 3);
});
