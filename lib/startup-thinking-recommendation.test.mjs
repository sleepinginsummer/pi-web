import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const { resolveStartupThinkingRecommendation } = await createJiti(import.meta.url).import("./startup-thinking-recommendation.ts");

test("浏览器旧目录的 A 推荐不能覆盖服务端实际启动 B 的规则", () => {
  const owner = { provider: "test", modelId: "a" };
  assert.equal(resolveStartupThinkingRecommendation("high", owner, { provider: "test", id: "b" }), undefined);
  assert.equal(resolveStartupThinkingRecommendation("high", owner, { provider: "other", id: "a" }), undefined);
  assert.equal(resolveStartupThinkingRecommendation("high", owner, undefined), undefined);
  assert.equal(resolveStartupThinkingRecommendation("high", owner, { provider: "test", id: "a" }), "high");
  // 没有归属的旧请求及手动档位保持兼容。
  assert.equal(resolveStartupThinkingRecommendation("high", undefined, { provider: "test", id: "b" }), "high");
});

test("推荐不会污染原生启动回退，并在延迟模型目标确定后校验", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.ok(source.includes("thinkingLevel && !thinkingLevelModel ? { thinkingLevel } : {}"));
  assert.ok(source.includes("resolveStartupThinkingRecommendation(requestedThinkingLevel, thinkingLevelModel, deferredModel ?? startupModel)"));
  const check = source.indexOf("thinkingLevel = resolveStartupThinkingRecommendation(requestedThinkingLevel, thinkingLevelModel, inner.model)");
  assert.ok(check > source.indexOf("const { session: inner, modelFallbackMessage } = await createAgentSessionFromServices"));
  assert.ok(check < source.indexOf("const persistedPreferences = await persistExplicitStartupPreferences"));
});
