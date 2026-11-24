import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const contextCommitSource = source.slice(
  source.indexOf("const commitContextSnapshot = useCallback"),
  source.indexOf("const startContextBackfill = useCallback"),
);
const switchSource = source.slice(
  source.indexOf("const handleModelChange = useCallback"),
  source.indexOf("const handleCompact = useCallback"),
);

test("existing-session model changes are optimistic and serialized", () => {
  const optimisticIndex = switchSource.indexOf("setCurrentModelOverride(target)");
  const requestIndex = switchSource.indexOf("await sendAgentCommand", optimisticIndex);

  assert.match(switchSource, /if \(!sid \|\| modelSwitchPendingRef\.current\) return/);
  assert.ok(optimisticIndex >= 0);
  assert.ok(requestIndex > optimisticIndex);
  assert.match(switchSource, /setModelSwitching\(true\)/);
  assert.match(switchSource, /setModelSwitching\(false\)/);
});

test("session reloads cannot clear an in-flight optimistic model", () => {
  assert.match(
    contextCommitSource,
    /setCurrentModelOverride\(\(current\) => modelSwitchPendingRef\.current \? current : null\)/,
  );
});

test("a completed model switch reloads canonical session state and reports failures", () => {
  assert.match(switchSource, /modelSwitchPendingRef\.current = false;[\s\S]*?invalidateSessionContext\(sid\);\s*await loadSession\(sid, false, true\)/);
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)[\s\S]*?await loadSession\(sid, false, true\)/);
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)/);
  assert.match(switchSource, /Failed to switch model:/);
});

test("已创建但未发送的新会话以服务端切换成功为准，失败保留原模型并提示", () => {
  const newSessionSwitch = switchSource.slice(0, switchSource.indexOf("const target ="));
  assert.match(newSessionSwitch, /creationSettingsLocked \|\| modelSwitchPendingRef\.current/);
  const request = newSessionSwitch.indexOf('type: "set_model"');
  const commit = newSessionSwitch.indexOf("newSessionModelOverrideRef.current = selectedModel");
  assert.ok(request >= 0 && request < commit);
  assert.match(newSessionSwitch, /catch \(e\)[\s\S]*?addNotice\([\s\S]*?return;/);
  assert.match(newSessionSwitch, /finally[\s\S]*?modelSwitchPendingRef\.current = false;[\s\S]*?setModelSwitching\(false\)/);
});

test("已有会话切模型不自己推算档位，由服务端按模型落一次", async () => {
  const existing = switchSource.slice(switchSource.indexOf("const target ="));
  // 服务端在 set_model 里定档（settings.json 的按模型档位优先），这里只用 reload / 实时快照读回来。
  assert.doesNotMatch(existing, /fetchPreferredThinkingLevel/);
  assert.doesNotMatch(existing, /type: "set_thinking_level"/);
  assert.match(existing, /await sendAgentCommand\(sid, \{ type: "set_model", provider, modelId \}\);/);

  const server = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
  const apply = server.slice(server.indexOf("private applyModelDefaultThinking"));
  // 显式写在 settings.json 里的按模型档位优先，自动推荐不能盖掉它。
  assert.match(apply, /if \(this\.inner\.settingsManager\.getModelThinkingLevel\(provider, modelId\)\) return;/);
  // 其次 enabledModels 的 :level pin、这个模型最近用过的众数，最后才是切换前的档位。
  assert.match(apply, /scopedModels\?\.find\(/);
  assert.match(apply, /pin \?\? readThinkingLevelRecommendation\(modelId\) \?\? previousLevel/);
  // 同身份保档与跨身份定档由 rpc-manager-model-config.integration.test.mjs 的真实 SDK 回归验证。
});

test("新会话切模型把档位换成新模型的常用档位", () => {
  const newSessionSwitch = switchSource.slice(0, switchSource.indexOf("const target ="));
  // 还没创建运行时：档位在这里算好，创建时随首条消息带上。
  assert.match(newSessionSwitch, /selectNewSessionModel\(selectedModel, \{ preserveLevel: sameModel \|\| Boolean\(sid\) \}\)/);
  assert.match(newSessionSwitch, /thinkingLevelOverrideRef\.current = null/);
  assert.match(newSessionSwitch, /recommendedThinkingLevelRef\.current = selection\.preferredThinking \?\? null/);
  // 已经有运行时的暂存会话：档位是服务端定的，读回来让界面和它一致。
  // 快照的档位只有被采纳时才写进草稿：用户在快照返回前改过档，applyRuntimeSnapshot 会跳过它。
  assert.match(newSessionSwitch, /const snapshot = await readAgentSnapshot\(sid\);[\s\S]{0,400}?const adoption = applyRuntimeSnapshot\(read, snapshot\.state\);[\s\S]{0,200}?if \(adoption\.thinking\) \{/);
});

test("重选同一个模型不动档位", () => {
  assert.match(switchSource, /const sameModel = displayModel\?\.provider === provider && displayModel\.modelId === modelId/);
  assert.match(switchSource, /preserveLevel: sameModel/);
});
