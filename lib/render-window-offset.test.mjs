import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { windowOffsetForGroup } = await jiti.import("./render-window-offset.ts");

test("目标已在最新一段时不需要移动窗口", () => {
  assert.equal(windowOffsetForGroup(2440, 2500, 160), 0);
  assert.equal(windowOffsetForGroup(2499, 2500, 160), 0);
});

test("目标在会话最前面时把窗口整体前移，让目标组落在窗口顶部", () => {
  // 2500 轮、只挂载 160 组：第一组需要从末尾回退 2340 组。
  assert.equal(windowOffsetForGroup(0, 2500, 160), 2340);
  // 回退后的窗口末端正好是「目标 + 160」，目标在窗口第一行。
  const total = 2500;
  const max = 160;
  const groupIndex = 0;
  const endIndex = total - windowOffsetForGroup(groupIndex, total, max);
  assert.equal(endIndex - max, groupIndex);
});

test("未知目标或组数不足时保持停在末尾", () => {
  assert.equal(windowOffsetForGroup(undefined, 2500, 160), 0);
  assert.equal(windowOffsetForGroup(-1, 2500, 160), 0);
  assert.equal(windowOffsetForGroup(0, 40, 160), 0);
});

test("窗口不会被算成负偏移", () => {
  assert.equal(windowOffsetForGroup(2490, 2500, 160), 0);
  assert.equal(windowOffsetForGroup(100, 2500, 160), 2240);
});
