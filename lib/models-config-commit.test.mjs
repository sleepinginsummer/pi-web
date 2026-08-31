import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  commitModelsConfigWithCapabilities,
  readModelsConfigWithCapabilities,
} = await createJiti(import.meta.url).import("./models-config-commit.ts");

function config(fast = true, modelId = "gpt-test") {
  return {
    providers: {
      custom: {
        api: "openai-responses",
        models: [{ id: modelId, fast }],
      },
    },
  };
}

test("双文件提交成功后 models.json 不包含临时能力字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-commit-"));
  const modelsPath = join(dir, "models.json");
  const capabilitiesPath = join(dir, "capabilities.json");

  await commitModelsConfigWithCapabilities(config(), { modelsPath, capabilitiesPath });

  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  const capabilities = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
  assert.equal(models.providers.custom.models[0].fast, undefined);
  assert.deepEqual(capabilities.fastModels, ["custom/gpt-test"]);
});

test("sidecar 写入失败时按原始字节恢复 models.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-rollback-"));
  const modelsPath = join(dir, "models.json");
  const originalModels = '{\n  "providers": {}\n}\n';
  writeFileSync(modelsPath, originalModels, "utf8");

  const blockedParent = join(dir, "not-a-directory");
  writeFileSync(blockedParent, "block", "utf8");
  const capabilitiesPath = join(blockedParent, "capabilities.json");

  await assert.rejects(
    commitModelsConfigWithCapabilities(config(), { modelsPath, capabilitiesPath }),
    /ENOTDIR/,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), originalModels);
});

test("后写在发布后报错时同时恢复 models.json 与已有 sidecar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-sidecar-rollback-"));
  const modelsPath = join(dir, "models.json");
  const capabilitiesPath = join(dir, "capabilities.json");
  const originalModels = '{"providers":{}}';
  const originalCapabilities = '{"fastModels":["legacy/model"]}';
  writeFileSync(modelsPath, originalModels, "utf8");
  writeFileSync(capabilitiesPath, originalCapabilities, "utf8");

  await assert.rejects(commitModelsConfigWithCapabilities(
    config(),
    { modelsPath, capabilitiesPath },
    {
      writeCapabilities: (fastModels, path) => {
        writeFileSync(path, JSON.stringify({ fastModels: [...fastModels] }), "utf8");
        throw new Error("injected sidecar failure");
      },
    },
  ), /injected sidecar failure/);

  assert.equal(readFileSync(modelsPath, "utf8"), originalModels);
  assert.equal(readFileSync(capabilitiesPath, "utf8"), originalCapabilities);
});

test("并发提交在跨进程锁内保持 models 与 sidecar 为同一快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-concurrent-"));
  const modelsPath = join(dir, "models.json");
  const capabilitiesPath = join(dir, "capabilities.json");

  const [, , readSnapshots] = await Promise.all([
    commitModelsConfigWithCapabilities(config(true, "gpt-a"), { modelsPath, capabilitiesPath }),
    commitModelsConfigWithCapabilities(config(true, "gpt-b"), { modelsPath, capabilitiesPath }),
    Promise.all([
      readModelsConfigWithCapabilities({ modelsPath, capabilitiesPath }),
      readModelsConfigWithCapabilities({ modelsPath, capabilitiesPath }),
    ]),
  ]);

  for (const snapshot of readSnapshots) {
    const readModel = snapshot.providers?.custom?.models?.[0];
    if (readModel) assert.equal(readModel.fast, true);
  }
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  const capabilities = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
  const finalModelId = models.providers.custom.models[0].id;
  assert.deepEqual(capabilities.fastModels, [`custom/${finalModelId}`]);
});
