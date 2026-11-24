import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initialModelSelectionState, modelSelectionReducer } = await jiti.import("./useModelSelection.ts");
const { resolveDisplayedThinkingLevel, resolvePreferredThinkingLevel } = await jiti.import("@/lib/thinking-levels");
const { readFile } = await import("node:fs/promises");

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
  // 目录刷新的 finally 要把两条通道都收干净（默认推荐 + models）。
  assert.match(source, /finally \{\s*loadGateRef\.current\.finish\("models"\);\s*loadGateRef\.current\.finish\("thinking-default"\);\s*\}/);
});

test("切模推荐走自己的 gate 通道，目录刷新不会把它作废", async () => {
  const source = await readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8");
  const switchSelector = source.slice(source.indexOf("const selectNewSessionModel"), source.indexOf("const setThinkingLevel"));

  // 目录刷新（load）重新开始 "thinking-default" 时只作废它自己的默认推荐；切模推荐若共用同一个
  // 通道，刷新先完成就会让切模退回「上一个模型的档位」提交，把 max 存到只支持 high 的模型上。
  assert.match(switchSelector, /loadGateRef\.current\.begin\("thinking-switch"\)/);
  assert.match(switchSelector, /loadGateRef\.current\.isLatest\("thinking-switch", generation\)/);
  assert.match(switchSelector, /loadGateRef\.current\.finish\("thinking-switch"\)/);
  assert.doesNotMatch(switchSelector, /loadGateRef\.current\.begin\("thinking-default"\)/);
  // 手动选档才算「用户抢先改了档」：靠修订号区分，而不是靠目录刷新。
  assert.match(switchSelector, /const manualRevision = thinkingChoiceRevisionRef\.current;/);
  assert.match(switchSelector, /if \(thinkingChoiceRevisionRef\.current !== manualRevision\) \{\s*return \{ status: "manual" \};/);
  assert.match(source, /thinkingChoiceRevisionRef\.current \+= 1;/);
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

test("新会话默认档位按真实 API 的键格式限幅", async () => {
  const source = await readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");

  // API 用冒号键写支持档位、pin 用斜杠键（`enabledModels` 的语法）。
  assert.match(route, /const key = `\$\{m\.provider\}:\$\{m\.id\}`;/);
  assert.match(route, /thinkingLevels\[key\] = getSupportedThinkingLevels\(m\);/);
  const scope = await readFile(new URL("../lib/model-scope.ts", import.meta.url), "utf8");
  assert.match(scope, /thinkingLevelPins\[`\$\{scoped\.model\.provider\}\/\$\{scoped\.model\.id\}`\] = scoped\.thinkingLevel;/);

  // 初始化必须两种键各用一次；用斜杠键查支持列表永远是 undefined，限幅就等于没做。
  assert.match(source, /const pinKey = `\$\{displayModel\.provider\}\/\$\{displayModel\.id\}`;/);
  assert.match(source, /const supportKey = `\$\{displayModel\.provider\}:\$\{displayModel\.id\}`;/);
  assert.match(source, /const pin = data\.thinkingLevelPins\?\.\[pinKey\] \?\? null;/);
  assert.match(source, /supported: data\.thinkingLevels\?\.\[supportKey\] \?\? null,/);

  // 真实响应结构下的结果：推荐 max、模型只支持到 high → 用 high。
  const thinkingLevels = { "p:m": ["off", "low", "medium", "high"] };
  const thinkingLevelPins = {};
  assert.equal(resolvePreferredThinkingLevel({
    pin: thinkingLevelPins["p/m"] ?? null,
    recommendation: "max",
    supported: thinkingLevels["p:m"] ?? null,
  }), "high");
});

test("草稿选了别的模型时，不套用默认模型的推荐档位", async () => {
  const source = await readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8");
  const loader = source.slice(source.indexOf("const load = useCallback"), source.indexOf("const selectNewSessionModel"));

  // 推荐按模型 id 查历史：草稿选了 B 却应用 A 的推荐，会把 A 的档位（可能还是 B 不支持的）
  // 用到 B 的首发请求上，界面也会跳回一个用户没选过的档位。
  assert.match(loader, /const draftModelMatches = \(\) => \{\s*const draftModel = newSessionModelRef\.current;\s*return !draftModel \|\| \(draftModel\.provider === displayModel\.provider && draftModel\.modelId === displayModel\.id\);/);
  assert.ok(
    loader.indexOf("if (!draftModelMatches()) return undefined;") < loader.indexOf("fetchThinkingLevelRecommendation"),
    "核对必须在取推荐之前",
  );
  // 取推荐期间草稿切到别的模型时，这份默认推荐同样不能再应用。
  // `null` 表示"适用但没有推荐"，调用方据此作废旧推荐；`undefined` 才是这次加载不适用。
  assert.match(loader, /onPreferredThinking\?\.\(\{ provider: displayModel\.provider, modelId: displayModel\.id \}, preferred\);/);
  assert.match(loader, /if \(!preferred\) \{\s*dispatch\(\{ type: "setThinkingLevel", level: "auto" \}\);\s*return null;/);
});

test("内部 auto 时用界面显示的档位兜底，并按新模型限幅", async () => {
  const source = await readFile(new URL("./useModelSelection.ts", import.meta.url), "utf8");

  // 内部 auto 表示"用户没显式选"，界面显示的是 settings 默认档位按当前模型限幅后的值。
  // 切模型时兜底必须用这个显示值：默认 max、旧模型最高只到 high 时界面显示 high，
  // 直接拿未限幅的 max 当兜底，切到支持 max 的模型后会选出一个界面从没显示过的档位。
  assert.match(source, /const previousModel = newSessionModelRef\.current \?\? newSessionDefaultModelRef\.current;/);
  assert.match(source, /const previousDisplayedLevel = thinkingLevelRef\.current === "auto"\s*\n\s*\? resolveDisplayedThinkingLevel\(\{/);
  assert.match(source, /supported: previousModel\s*\n\s*\? \(thinkingLevelsRef\.current\[`\$\{previousModel\.provider\}:\$\{previousModel\.modelId\}`\] \?\? null\)\s*\n\s*: null,/);
  assert.match(source, /current: previousDisplayedLevel,/);
  // 取值必须在 dispatch 之前：dispatch 之后 state 里的模型已经是新的了。
  assert.ok(
    source.indexOf("const previousDisplayedLevel") < source.indexOf('dispatch({ type: "selectNewSessionModel", model });'),
    "兜底档位要在切换之前按旧模型算",
  );

  assert.equal(resolveDisplayedThinkingLevel({ level: "auto", fallback: "max", supported: ["off", "low", "medium", "high"] }), "high");
  assert.equal(resolvePreferredThinkingLevel({ current: "high", supported: ["off", "low", "medium", "high", "max"] }), "high");
});
