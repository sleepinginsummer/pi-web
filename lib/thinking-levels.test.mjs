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
  clampThinkingLevelToSupported,
  resolvePreferredThinkingLevel,
  resolveDisplayedThinkingLevel,
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

test("不支持时按 pi 的限幅规则先往上找，再往下找", () => {
  const claude = ["off", "minimal", "low", "medium", "high"];
  assert.equal(clampThinkingLevelToSupported("max", claude), "high");
  assert.equal(clampThinkingLevelToSupported("xhigh", claude), "high");
  assert.equal(clampThinkingLevelToSupported("minimal", claude), "minimal", "受支持就原样返回");
  const noMedium = ["off", "low", "high"];
  assert.equal(clampThinkingLevelToSupported("medium", noMedium), "high", "先往上找");
  assert.equal(clampThinkingLevelToSupported("max", ["off", "low"]), "low");
  assert.equal(clampThinkingLevelToSupported("max", []), "max", "名单未知时不动");
  assert.equal(clampThinkingLevelToSupported("max", null), "max");
});

test("切模型的档位：pin → 众数 → 当前档位，再限幅", () => {
  const claude = ["off", "minimal", "low", "medium", "high"];
  assert.equal(resolvePreferredThinkingLevel({ pin: "low", recommendation: "max", supported: claude }), "low");
  assert.equal(resolvePreferredThinkingLevel({ recommendation: "max", supported: claude }), "high");
  // 没有 pin/众数：沿用当前档位，但不支持的档位要先落进新模型的列表。
  assert.equal(resolvePreferredThinkingLevel({ current: "medium", supported: claude }), "medium");
  assert.equal(resolvePreferredThinkingLevel({ current: "max", supported: claude }), "high");
  assert.equal(resolvePreferredThinkingLevel({ current: "auto", supported: claude }), null);
  assert.equal(resolvePreferredThinkingLevel({}), null);
});

test("界面显示的档位：auto 用默认值，并按当前模型限幅", () => {
  const claude = ["off", "minimal", "low", "medium", "high"];
  // 用户显式选过的档位原样显示。
  assert.equal(resolveDisplayedThinkingLevel({ level: "max", fallback: "low", supported: claude }), "max");
  // auto：显示 settings 的默认档位，但模型做不到时要落进它支持的列表。
  assert.equal(resolveDisplayedThinkingLevel({ level: "auto", fallback: "max", supported: claude }), "high");
  assert.equal(resolveDisplayedThinkingLevel({ level: "auto", fallback: "max", supported: null }), "max");
  assert.equal(resolveDisplayedThinkingLevel({ level: "auto", fallback: null, supported: claude }), "auto");
  // 活动会话的 auto 表示"跟随服务端"，不套新会话的默认值。
  assert.equal(resolveDisplayedThinkingLevel({ level: "auto", fallback: null }), "auto");
});
