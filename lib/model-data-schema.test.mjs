import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseModelsData } = await jiti.import("./model-data-schema.ts");

function validData() {
  return {
    models: { "p:m": "Model" },
    modelList: [{ id: "m", name: "Model", provider: "p", fastAvailable: true }],
    defaultModel: { provider: "p", modelId: "m" },
    thinkingLevels: { "p:m": ["off", "high"] },
    thinkingLevelMaps: { "p:m": { off: null, high: "high" } },
    thinkingLevelPins: { "p/m": "high" },
  };
}

test("严格拒绝缺失或畸形的必需字段", () => {
  assert.throws(() => parseModelsData({}), /models must be an object/);
  assert.throws(() => parseModelsData({ ...validData(), modelList: {} }), /modelList must be an array/);
  assert.throws(() => parseModelsData({ ...validData(), thinkingLevels: { "p:m": "high" } }), /must be an array/);
  assert.throws(() => parseModelsData({ ...validData(), modelList: [{ id: "m", name: "Model", provider: "p" }] }), /malformed/);
  assert.equal(parseModelsData(validData()).data.modelList[0].fastAvailable, true);
});

test("过滤未知等级并返回结构化诊断", () => {
  const raw = validData();
  raw.thinkingLevels["p:m"].push("future");
  raw.thinkingLevelMaps["p:m"].future = "future";
  raw.thinkingLevelPins["p/m"] = "future";
  const result = parseModelsData(raw);

  assert.deepEqual(result.data.thinkingLevels["p:m"], ["off", "high"]);
  assert.equal("future" in result.data.thinkingLevelMaps["p:m"], false);
  assert.equal(result.data.thinkingLevelPins["p/m"], undefined);
  assert.deepEqual(result.diagnostics.map((item) => item.code), [
    "unknown-level",
    "unknown-map-level",
    "unknown-pin",
  ]);
});

test("保留合法模型数据和思考等级", () => {
  const result = parseModelsData(validData());
  assert.equal(result.data.defaultModel?.modelId, "m");
  assert.deepEqual(result.data.thinkingLevels["p:m"], ["off", "high"]);
  assert.equal(result.data.thinkingLevelPins["p/m"], "high");
  assert.deepEqual(result.diagnostics, []);
});
