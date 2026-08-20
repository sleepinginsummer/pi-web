import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createFastSessionModel, isFastModeAvailable } = await createJiti(import.meta.url).import("./fast-mode.ts");

function responsesModel(overrides = {}) {
  return {
    id: "gpt-test",
    provider: "openai",
    api: "openai-responses",
    compat: { supportsReasoningEffort: true },
    samplingParams: { temperature: 0.2 },
    ...overrides,
  };
}

test("Fast 仅开放给协议兼容且明确授权的 provider", () => {
  assert.equal(isFastModeAvailable(responsesModel({ provider: "openai" })), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "sleepinsum-test" })), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "sleepinsum-0.16", api: "openai-completions" })), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "sleepinsum-0.16", api: "openai-codex-responses" })), false);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "deepseek" })), false);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "365-4090" })), false);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "sleepinsum-grok" })), false);
});

test("Fast 模型使用独立浅拷贝，不污染 catalog", () => {
  const catalog = responsesModel();
  const sessionModel = createFastSessionModel(catalog, true);

  assert.notEqual(sessionModel, catalog);
  assert.notEqual(sessionModel.compat, catalog.compat);
  assert.notEqual(sessionModel.samplingParams, catalog.samplingParams);
  assert.deepEqual(sessionModel.samplingParams, { temperature: 0.2, service_tier: "priority" });
  assert.deepEqual(catalog.samplingParams, { temperature: 0.2 });
});
