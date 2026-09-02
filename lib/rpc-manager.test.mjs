import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
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

test("RPC snapshot distinguishes wrapper lifetime from busy execution", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export async function getRpcSessionSnapshot"),
    source.indexOf("export function hasBusyRpcSessionForCwd"),
  );

  assert.match(snapshotSource, /return \{ alive: false, busy: false \}/);
  assert.match(snapshotSource, /alive: true, busy: session\.isRunning\(\), state/);
});
test("normal teardown paths remain graceful while fork keeps the source wrapper alive", async () => {
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
  assert.match(forkSource, /createForkedSession\(currentSessionFile, entryId\)/);
  assert.doesNotMatch(forkSource, /shutdown\(/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("clone uses the independent atomic file service and keeps the source wrapper alive", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(source.indexOf('case "clone"'), source.indexOf('case "navigate_tree"'));
  assert.match(cloneSource, /createClonedSession\(currentSessionFile, leafId\)/);
  assert.doesNotMatch(cloneSource, /shutdown\(/);
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
  assert.match(startupSource, /modelDefaultChanged && inner\.model[\s\S]*updateCachedDefaultModel\(sessionCwd/);
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

  assert.match(reloadSource, /await this\.reloadRuntime\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(this\.cwd\)/);
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

test("abort releases pending extension UI before waiting for the session to become idle", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const abortSource = source.slice(
    source.indexOf('case "abort":'),
    source.indexOf('case "get_state":'),
  );
  const cancelSource = source.slice(
    source.indexOf("private cancelPendingExtensionUis"),
    source.indexOf("private applyForcedEmptySystemPrompt"),
  );
  const dialogSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private createExtensionUiContext"),
  );

  assert.match(abortSource, /this\.aborting = true/);
  assert.ok(abortSource.indexOf("this.cancelPendingExtensionUis()") < abortSource.indexOf("this.inner.abort()"));
  assert.match(cancelSource, /pendingUiResponses\.get\(id\)\?\.cancel\(\)/);
  assert.match(cancelSource, /type: "extension_ui_closed"/);
  assert.match(cancelSource, /closeCustomUi\(id, undefined\)/);
  assert.match(cancelSource, /activeAskToolStarts\.clear\(\)/);
  assert.match(dialogSource, /signal\?\.aborted \|\| this\.aborting/);
  assert.match(dialogSource, /typeof factory !== "function" \|\| this\.aborting/);
});

test("abort does not let a cancelled ask dialog immediately enqueue another blocking dialog", async () => {
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  let extensionSequence;
  const inner = {
    isBashRunning: false,
    sessionManager: { getEntries: () => [] },
    extensionRunner: { getRegisteredCommands: () => [] },
    abort: async () => { await extensionSequence; },
    dispose: () => {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const ui = wrapper.createExtensionUiContext();
  const firstQuestion = ui.select("第一题", ["A", "B"]);
  extensionSequence = firstQuestion.then(() => ui.select("第二题", ["C", "D"]));

  await Promise.race([
    wrapper.send({ type: "abort" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort 超过 500ms 未返回")), 500)),
  ]);

  assert.equal(await extensionSequence, undefined);
  assert.equal(events.filter((event) => event.type === "extension_ui_request").length, 1);
  assert.equal(events.filter((event) => event.type === "extension_ui_closed").length, 1);
  wrapper.destroy();
});

test("SSE reconnect replays the active ask definition before its pending UI request", async () => {
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  let publishAgentEvent;
  const inner = {
    sessionId: "ask-reconnect-session",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
    extensionRunner: { getRegisteredCommands: () => [] },
    subscribe: (listener) => {
      publishAgentEvent = listener;
      return () => {};
    },
    dispose: () => {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();

  publishAgentEvent({
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask_user_question",
    args: { questions: [{}, {}] },
  });
  const pendingSelection = wrapper.createExtensionUiContext().select("第一题", ["A", "B"]);

  const replayedEvents = [];
  wrapper.onEvent((event) => replayedEvents.push(event));
  assert.deepEqual(
    replayedEvents.map((event) => event.type),
    ["tool_execution_start", "extension_ui_request"],
  );
  assert.equal(replayedEvents[0].toolCallId, "ask-1");

  await wrapper.send({
    type: "extension_ui_response",
    id: replayedEvents[1].id,
    value: "A",
  });
  assert.equal(await pendingSelection, "A");

  publishAgentEvent({
    type: "tool_execution_end",
    toolCallId: "ask-1",
    toolName: "ask_user_question",
  });
  const afterCompletion = [];
  wrapper.onEvent((event) => afterCompletion.push(event));
  assert.deepEqual(afterCompletion, []);
  wrapper.destroy();
});

test("Shadow runtime bind and reload share the same fail-soft restore boundary", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const bindSource = source.slice(source.indexOf("private ensureExtensionsBound"), source.indexOf("private async waitForExtensionsBound"));
  const reloadSource = source.slice(source.indexOf('case "reload"'), source.indexOf('case "abort_compaction"'));

  assert.match(bindSource, /await this\.restoreShadowSessionSetting\(\)/);
  assert.match(reloadSource, /await this\.restoreShadowSessionSetting\(\)/);
  assert.doesNotMatch(source, /shadowSessionSetting\.restoreAfterRuntimeReset\(\)/);
});

test("direct prompt Shadow toggle uses the persisted session coordinator", async () => {
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const entries = [];
  const actions = [];
  const sessionManager = {
    getEntries: () => entries,
    appendCustomEntry(customType, data) {
      const entry = { type: "custom", customType, data, id: `entry-${entries.length + 1}` };
      entries.push(entry);
      return entry.id;
    },
    getEntry: (id) => entries.find((entry) => entry.id === id),
  };
  const inner = {
    sessionId: "session-shadow",
    sessionManager,
    extensionRunner: {
      getRegisteredCommands: () => [{
        name: "shadow",
        sourceInfo: { path: "/pkg/pi-shadow-mind/dist/index.js", source: "npm:pi-shadow-mind" },
        handler: async (action) => { actions.push(action); },
      }],
      createCommandContext: () => ({}),
    },
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    dispose: () => {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  try {
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "/shadow PAUSE" }), { kind: "shadow-setting", enabled: false });
    assert.deepEqual(actions, ["pause"]);
    assert.equal(entries.at(-1)?.customType, "pi-web-shadow-mind-state");
    assert.deepEqual(entries.at(-1)?.data, { enabled: false });
  } finally {
    wrapper.destroy();
  }
});
