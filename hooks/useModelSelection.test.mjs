import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initialModelSelectionState, modelSelectionReducer } = await jiti.import("./useModelSelection.ts");

test("模型响应通过一次 reducer action 原子更新", () => {
  const next = modelSelectionReducer(initialModelSelectionState, {
    type: "modelsLoaded",
    applyNewSessionDefaults: true,
    applyPinnedThinking: true,
    payload: {
      state: {
        names: { "p/m": "Model" },
        list: [{ provider: "p", id: "m", name: "Model" }],
        error: null,
        scopeWarnings: ["warning"],
        dataDiagnostics: [],
        thinkingLevels: { "p:m": ["high"] },
        thinkingLevelMaps: {},
        thinkingLevelPins: { "p/m": "high" },
      },
      defaultModel: { provider: "p", modelId: "m" },
      pinnedThinkingLevel: "high",
    },
  });

  assert.deepEqual(next.names, { "p/m": "Model" });
  assert.deepEqual(next.newSessionDefaultModel, { provider: "p", modelId: "m" });
  assert.equal(next.thinkingLevel, "high");
});


test("模型加载失败会清空旧目录并写入可展示错误", () => {
  const stale = {
    ...initialModelSelectionState,
    names: { "p/old": "Old" },
    list: [{ provider: "p", id: "old", name: "Old" }],
  };
  const next = modelSelectionReducer(stale, { type: "modelsLoadFailed", error: "HTTP 503" });
  assert.deepEqual(next.names, {});
  assert.deepEqual(next.list, []);
  assert.equal(next.error, "HTTP 503");
});
test("模型加载只允许最新 generation 提交成功或失败", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8"));
  assert.match(source, /const modelsGeneration = loadGateRef\.current\.begin\("models"\)/);
  assert.equal((source.match(/!loadGateRef\.current\.isLatest\("models", modelsGeneration\)/g) ?? []).length, 2);
  assert.match(source, /finally \{[\s\S]*loadGateRef\.current\.finish\("models"\)/);
  assert.match(source, /loadGateRef\.current\.invalidate\("thinking-default"\)/);
  assert.match(source, /finally \{\s*loadGateRef\.current\.finish\("thinking-default"\)/);
});

test("活动会话模型不进入模型选择 reducer", () => {
  assert.equal(Object.hasOwn(initialModelSelectionState, "model"), false);
  assert.equal(Object.hasOwn(initialModelSelectionState, "currentModel"), false);
});

test("模型推荐动作不依赖加载后变化的 state，避免取消新会话推荐请求", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8"));
  const selector = source.slice(source.indexOf("const selectNewSessionModel"), source.indexOf("const setThinkingLevel"));

  assert.match(selector, /thinkingLevelPinsRef\.current/);
  assert.match(selector, /\}, \[\]\);/);
  assert.doesNotMatch(selector, /\[state\.thinkingLevelPins\]/);
});
