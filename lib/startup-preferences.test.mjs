import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { persistExplicitStartupPreferences } = await createJiti(import.meta.url)
  .import("./startup-preferences.ts");

async function withSettings(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-startup-preferences-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  try {
    const settings = SettingsManager.create(cwd, agentDir);
    await run({ settings, settingsPath: join(agentDir, "settings.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("persists explicit effective model and thinking defaults", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    const result = await persistExplicitStartupPreferences(
      settings,
      {
        model: { provider: "deepseek", modelId: "deepseek-chat" },
        thinkingLevel: "xhigh",
      },
      {
        model: { provider: "deepseek", modelId: "deepseek-chat" },
        thinkingLevel: "high",
        supportsThinking: true,
      },
    );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(
      {
        defaultProvider: saved.defaultProvider,
        defaultModel: saved.defaultModel,
        defaultThinkingLevel: saved.defaultThinkingLevel,
      },
      {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        defaultThinkingLevel: "high",
      },
    );
    assert.equal(result.modelDefaultChanged, true);
  });
});

test("does not persist implicit scope selections", async () => {
  await withSettings(async ({ settings }) => {
    settings.setDefaultModelAndProvider("saved", "saved-model");
    settings.setDefaultThinkingLevel("medium");
    await settings.flush();

    const result = await persistExplicitStartupPreferences(
      settings,
      {},
      {
        model: { provider: "scoped", modelId: "scoped-model" },
        thinkingLevel: "high",
        supportsThinking: true,
      },
    );

    assert.equal(settings.getDefaultProvider(), "saved");
    assert.equal(settings.getDefaultModel(), "saved-model");
    assert.equal(settings.getDefaultThinkingLevel(), "medium");
    assert.equal(result.modelDefaultChanged, false);
  });
});

test("does not persist a model when startup resolved a different model", async () => {
  await withSettings(async ({ settings }) => {
    const result = await persistExplicitStartupPreferences(
      settings,
      { model: { provider: "requested", modelId: "requested-model" } },
      {
        model: { provider: "fallback", modelId: "fallback-model" },
        thinkingLevel: "off",
        supportsThinking: false,
      },
    );

    assert.equal(settings.getDefaultProvider(), undefined);
    assert.equal(settings.getDefaultModel(), undefined);
    assert.equal(result.modelDefaultChanged, false);
  });
});

test("does not replace a reasoning default with off for a non-thinking model", async () => {
  await withSettings(async ({ settings }) => {
    settings.setDefaultThinkingLevel("high");
    await settings.flush();

    await persistExplicitStartupPreferences(
      settings,
      { thinkingLevel: "off" },
      { thinkingLevel: "off", supportsThinking: false },
    );

    assert.equal(settings.getDefaultThinkingLevel(), "high");
  });
});

test("新会话默认值写入必须传播 SDK 收集的持久化错误", async () => {
  const failure = new Error("settings write failed");
  let flushed = false;
  const settings = {
    drainErrors: () => flushed ? [{ scope: "global", error: failure }] : [],
    setDefaultModelAndProvider() {},
    setDefaultThinkingLevel() {},
    async flush() { flushed = true; },
  };

  await assert.rejects(
    persistExplicitStartupPreferences(
      settings,
      { model: { provider: "chosen", modelId: "chosen-model" }, thinkingLevel: "high" },
      { model: { provider: "chosen", modelId: "chosen-model" }, thinkingLevel: "high", supportsThinking: true },
    ),
    (error) => error === failure,
  );
});

test("全局配置加载失败时新会话不得调用默认值 setter", async () => {
  const failure = new Error("settings load failed");
  const settings = {
    drainErrors: () => [{ scope: "global", error: failure }],
    setDefaultModelAndProvider() { assert.fail("不应覆盖加载失败的配置"); },
    async flush() { assert.fail("不应写入加载失败的配置"); },
  };

  await assert.rejects(
    persistExplicitStartupPreferences(
      settings,
      { model: { provider: "chosen", modelId: "chosen-model" } },
      { model: { provider: "chosen", modelId: "chosen-model" }, thinkingLevel: "off", supportsThinking: false },
    ),
    (error) => error === failure,
  );
});
