import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  // 创建参数按草稿的最新一份取（切走再回来时模型是在另一个实例里选的），但仍然只发显式选择：
  // 草稿状态里的模型只由用户切模写入，档位也只在不是 "auto" 时才带上。
  assert.match(ensureSource, /const selectedModel = latest\.model;/);
  assert.match(ensureSource, /const selectedThinkingLevel = latest\.thinkingLevel;/);
  assert.doesNotMatch(ensureSource, /newSessionDefaultModel/);
  assert.doesNotMatch(ensureSource, /thinkingLevel !== "auto"/);
  const settingsSource = source.slice(
    source.indexOf("const currentNewSessionSettings = useCallback"),
    source.indexOf("const promptRunIdRef = useRef"),
  );
  assert.match(settingsSource, /const model = settings\?\.model \?\? newSessionModelOverrideRef\.current \?\? null;/);
  assert.match(settingsSource, /settings\.thinkingLevel === "auto" \? null : settings\.thinkingLevel/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(
    ensureSource,
    /result\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(ensureSource, /setPendingModel\(result\.model\)/);
  assert.match(ensureSource, /setNewSessionDefaultModel\(result\.model\)/);
  assert.match(
    ensureSource,
    /\(thinkingLevelOverrideRef\.current \?\? recommendedThinkingLevelRef\.current\) === selectedThinkingLevel/,
  );
  assert.match(ensureSource, /setThinkingLevel\(result\.thinkingLevel\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /draftControl = isNew && !sessionIdRef\.current \? currentDraftControl\(\) : null;/);
  assert.match(loadModelsSource, /if \(!isNew \|\| sessionIdRef\.current\) return;/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /preferredThinking = await modelSelectionActions\.load/);
  assert.match(loadModelsSource, /recommendedThinkingLevelRef\.current = preferredThinking/);
});
