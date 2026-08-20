import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  THINKING_LEVELS,
  THINKING_LEVEL_OPTIONS,
  isThinkingLevel,
  isThinkingLevelOption,
  parseThinkingLevelOption,
} = await jiti.import("./thinking-levels.ts");

const expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("暴露完整且唯一的 SDK 思考等级列表", () => {
  assert.deepEqual([...THINKING_LEVELS], expected);
  assert.equal(new Set(THINKING_LEVELS).size, THINKING_LEVELS.length);
});

test("auto 只存在于前端选项，不是 SDK 实际等级", () => {
  assert.deepEqual([...THINKING_LEVEL_OPTIONS], ["auto", ...expected]);
  assert.equal(isThinkingLevel("auto"), false);
  assert.equal(isThinkingLevelOption("auto"), true);
});

test("未知选项回退到 auto，不穿透到 SDK", () => {
  assert.equal(parseThinkingLevelOption("future"), "auto");
  assert.equal(parseThinkingLevelOption("high"), "high");
});

test("运行时守卫拒绝未知值", () => {
  for (const level of expected) {
    assert.equal(isThinkingLevel(level), true);
    assert.equal(isThinkingLevelOption(level), true);
  }
  for (const value of ["unknown", "", null, 1]) {
    assert.equal(isThinkingLevel(value), false);
    assert.equal(isThinkingLevelOption(value), false);
  }
});
