import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createFastSessionModel,
  isFastModeAvailable,
  resolveFastModeAvailability,
} = await createJiti(import.meta.url).import("./fast-mode.ts");

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

test("Fast 三态 selector 仅在 runtime 未物化时回退 catalog", () => {
  assert.equal(resolveFastModeAvailability(null, true), true);
  assert.equal(resolveFastModeAvailability(null, false), false);
  assert.equal(resolveFastModeAvailability(true, false), true);
  assert.equal(resolveFastModeAvailability(false, true), false);
});

test("Fast 仅开放给协议兼容且模型明确声明能力的 provider", () => {
  const configured = new Set(["custom/gpt-test"]);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "openai" }), new Set()), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "custom" }), configured), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "custom", api: "openai-completions" }), configured), true);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "custom", api: "openai-codex-responses" }), configured), false);
  assert.equal(isFastModeAvailable(responsesModel({ provider: "unconfigured" }), configured), false);
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
