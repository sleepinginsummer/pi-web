import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  extractFastModelCapabilities,
  mergeFastModelCapabilities,
  readFastModelCapabilities,
  writeFastModelCapabilities,
} = await createJiti(import.meta.url).import("./model-capabilities.ts");

function modelsConfig() {
  return {
    providers: {
      custom: {
        api: "openai-responses",
        models: [
          { id: "fast-model", reasoning: true },
          { id: "regular-model" },
        ],
      },
    },
  };
}

test("Fast 能力通过临时模型字段往返且不污染 models.json", () => {
  const merged = mergeFastModelCapabilities(modelsConfig(), new Set(["custom/fast-model"]));
  assert.equal(merged.providers.custom.models[0].fast, true);
  assert.equal(merged.providers.custom.models[1].fast, undefined);

  const { modelsConfig: cleaned, fastModels } = extractFastModelCapabilities(merged);
  assert.deepEqual([...fastModels], ["custom/fast-model"]);
  assert.equal(cleaned.providers.custom.models[0].fast, undefined);
});

test("按当前模型快照重建 Fast 能力，删除模型后不保留旧键", () => {
  const config = modelsConfig();
  config.providers.custom.models[1].fast = true;
  const { fastModels } = extractFastModelCapabilities(config);
  assert.deepEqual([...fastModels], ["custom/regular-model"]);
});

test("Fast sidecar 采用稳定排序并容忍损坏文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-capabilities-"));
  const path = join(dir, "capabilities.json");
  writeFastModelCapabilities(["z/model", "a/model", "z/model"], path);
  assert.deepEqual([...readFastModelCapabilities(path)], ["a/model", "z/model"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    fastModels: ["a/model", "z/model"],
  });

  writeFileSync(path, "not json", "utf8");
  assert.deepEqual([...readFastModelCapabilities(path)], []);
});
