import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clampSwipeOffset, shouldOpenSwipeActions, SwipeActionMachine } = await jiti.import("./useSwipeActions.ts");

test("会话操作位移只能在关闭态和菜单宽度之间", () => {
  assert.equal(clampSwipeOffset(20, 132), 0);
  assert.equal(clampSwipeOffset(-60, 132), -60);
  assert.equal(clampSwipeOffset(-180, 132), -132);
});

test("左滑超过菜单宽度的 42% 才展开操作", () => {
  assert.equal(shouldOpenSwipeActions(-55, 132), false);
  assert.equal(shouldOpenSwipeActions(-56, 132), true);
  assert.equal(shouldOpenSwipeActions(0, 132), false);
});

test("完整左滑序列抑制合成点击，下一次点击只收起菜单", () => {
  const machine = new SwipeActionMachine(132, false);
  machine.begin(1, 200, 100);
  assert.deepEqual(machine.move(1, 130, 102), { horizontal: true, startedDragging: true, offset: -70 });
  assert.deepEqual(machine.move(1, 60, 102), { horizontal: true, startedDragging: false, offset: -132 });
  assert.deepEqual(machine.finish(1, false, 100), { handled: true, open: true, offset: -132 });

  assert.equal(machine.consumeClick(true, 101), true, "消费滑动结束后的合成 click");
  assert.equal(machine.open, true, "合成 click 不应立即收起刚展开的菜单");

  machine.begin(2, 80, 100);
  assert.deepEqual(machine.finish(2, false, 200), { handled: false, open: true, offset: -132 });
  assert.equal(machine.consumeClick(true, 200), true, "展开后再次轻点由菜单消费");
  assert.equal(machine.open, false, "再次轻点只收起菜单，不进入会话");
  assert.equal(machine.offset, 0);
});

test("横滑未产生合成 click 时，抑制窗口不会吞掉后续真实轻点", () => {
  const machine = new SwipeActionMachine(132, false);
  machine.begin(1, 200, 100);
  machine.move(1, 60, 100);
  machine.finish(1, false, 100);

  machine.begin(2, 80, 100);
  machine.finish(2, false, 300);
  assert.equal(machine.consumeClick(true, 300), true);
  assert.equal(machine.open, false);
  assert.equal(machine.offset, 0);
});
