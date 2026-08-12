import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.getBranch\(\)\.some\(\(entry\) => entry\.type === "message"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /await this\.shutdown\(\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("RPC session startup logs stage timings without prompt content", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  for (const timing of ["services", "modelScope", "sessionCreate", "preferences"]) {
    assert.match(startupSource, new RegExp(`startupTimings\\.${timing} = elapsedMs`));
  }
  assert.match(startupSource, /RPC session startup failed/);
  assert.match(startupSource, /stage: startupStage/);
  assert.doesNotMatch(startupSource, /message:/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("detects unfinished tool calls from agent_end messages and auto-continues once at settle", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const detectorSource = source.slice(
    source.indexOf("function findUnfinishedToolCall"),
    source.indexOf("// AgentSessionWrapper"),
  );
  const startSource = source.slice(
    source.indexOf("  start(): void {"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const settleSource = source.slice(
    source.indexOf("private maybeAutoContinueUnfinishedTool"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );

  // 检测器：只看最后一轮 assistant 的 toolCall 是否缺少对应 toolResult
  assert.match(detectorSource, /function findUnfinishedToolCall/);
  assert.match(detectorSource, /\.filter\(\(block\) => block\.type === "toolCall"\)/);
  assert.match(detectorSource, /resultIds\.add\(result\.toolCallId\)/);
  assert.match(detectorSource, /!resultIds\.has\(call\.id\)/);

  // agent_end 缓存完整消息，agent_settled 时触发检测
  assert.match(startSource, /event\.type === "agent_end"/);
  assert.match(startSource, /this\.lastAgentEndMessages = Array\.isArray\(event\.messages\)/);
  assert.match(startSource, /event\.type === "agent_settled"[\s\S]*?this\.maybeAutoContinueUnfinishedTool\(\)/);

  // 限制：aborted/error/willRetry 不恢复；同一工具调用不重复；每轮最多 3 次
  assert.match(settleSource, /stopReason === "aborted"/);
  assert.match(settleSource, /stopReason === "error"/);
  assert.match(settleSource, /willRetry/);
  assert.match(settleSource, /MAX_AUTO_CONTINUE_TURNS/);
  assert.match(settleSource, /this\.lastAutoContinuedToolCallId === unfinished\.toolCallId/);
  assert.match(settleSource, /this\.inner\.followUp\(/);
  assert.match(settleSource, /type: "auto_continue"/);
  assert.match(settleSource, /type: "auto_continue_stopped"/);
});

test("agent_settled triggers one-shot file-level session title generation", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void {"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const titleSource = source.slice(
    source.indexOf("private maybeAutoTitleSession"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );

  // agent_settled 时触发（与工具中断恢复并列），且只尝试一次
  assert.match(startSource, /event\.type === "agent_settled"[\s\S]*?this\.maybeAutoTitleSession\(\)/);
  assert.match(titleSource, /autoTitleTriggered/);
  // 走文件级独立 services（不借用主 agent transport），成功后广播事件刷新前端
  assert.match(titleSource, /generateTitleForSessionFile\(/);
  assert.match(titleSource, /existsSync\(sessionFile\)/);
  assert.match(titleSource, /invalidateSessionListCache\(\)/);
  assert.match(titleSource, /type: "session_title_generated"/);
  assert.match(titleSource, /console\.error\(/);
});

test("new user prompt resets the auto-continue counters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf("case \"prompt\": {"),
    source.indexOf("case \"abort\":"),
  );
  assert.match(promptSource, /this\.autoContinueCount = 0/);
  assert.match(promptSource, /this\.lastAutoContinuedToolCallId = null/);
});
