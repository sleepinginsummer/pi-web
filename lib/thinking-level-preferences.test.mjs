import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  readThinkingLevelRecommendation,
  recommendThinkingLevel,
  recordThinkingLevelUsage,
} = await createJiti(import.meta.url).import("./thinking-level-preferences.ts");

async function withPreferenceFile(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-thinking-preferences-"));
  const filePath = join(root, "preferences.json");
  try {
    await run(filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("按 modelId 统计并忽略 provider", () => {
  const usages = [
    { modelId: "model-a", thinkingLevel: "max" },
    { modelId: "model-b", thinkingLevel: "low" },
    { modelId: "model-a", thinkingLevel: "max" },
    { modelId: "model-a", thinkingLevel: "high" },
  ];
  assert.equal(recommendThinkingLevel(usages, "model-a"), "max");
});

test("频次并列时选择最近使用的等级", () => {
  const usages = [
    { modelId: "model-a", thinkingLevel: "max" },
    { modelId: "model-a", thinkingLevel: "high" },
  ];
  assert.equal(recommendThinkingLevel(usages, "model-a"), "high");
});

test("每个推荐只考虑全局记录中最近 50 次同模型用法", () => {
  const usages = [
    ...Array.from({ length: 10 }, () => ({ modelId: "model-a", thinkingLevel: "high" })),
    ...Array.from({ length: 50 }, () => ({ modelId: "model-a", thinkingLevel: "max" })),
  ];
  assert.equal(recommendThinkingLevel(usages, "model-a"), "max");
});

test("损坏文件读取为无推荐", async () => {
  await withPreferenceFile(async (filePath) => {
    await writeFile(filePath, "not json", "utf8");
    assert.equal(readThinkingLevelRecommendation("model-a", filePath), null);
  });
});

test("并发记录在同一个锁事务中完成且不丢失不同模型", async () => {
  await withPreferenceFile(async (filePath) => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordThinkingLevelUsage({
      modelId: `model-${index}`,
      thinkingLevel: index % 2 === 0 ? "high" : "max",
    }, filePath)));

    const saved = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(Object.keys(saved.models).length, 20);
  });
});

test("每个模型独立保留最近 50 次记录", async () => {
  await withPreferenceFile(async (filePath) => {
    for (let index = 0; index < 55; index += 1) {
      await recordThinkingLevelUsage({ modelId: "model-a", thinkingLevel: index < 5 ? "low" : "max" }, filePath);
      await recordThinkingLevelUsage({ modelId: `other-${index}`, thinkingLevel: "high" }, filePath);
    }

    const saved = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(saved.models["model-a"].length, 50);
    assert.ok(saved.models["model-a"].every((level) => level === "max"));
    assert.equal(readThinkingLevelRecommendation("model-a", filePath), "max");
  });
});
