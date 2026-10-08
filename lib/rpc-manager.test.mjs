import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import test from "node:test";

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("only normal sessions load the codemode, tool-search, and mcp built-ins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const builtins = subagentResources \|\| chatOnly\s*\? undefined\s*: await createPiWebBuiltinExtensions\(\{ agentDir \}\);/,
  );
  // Spread only into the normal-session factories, after the chat-only and subagent branches.
  assert.equal(startupSource.match(/\.\.\.\(builtins\?\.extensions \?\? \[\]\)/g)?.length, 1);
  assert.ok(
    startupSource.indexOf("...(builtins?.extensions") > startupSource.indexOf("CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories"),
  );
  // The Read-only policy for MCP tools rides along with the MCP extension.
  assert.match(startupSource, /\.\.\.\(builtins\?\.extensions \?\? \[\]\),\s*createReadOnlyMcpPolicyExtension\(\),/);
  // The wrapper connects the host's servers before a prompt starts a run.
  assert.match(startupSource, /\.\.\.\(builtins\?\.mcpHost \? \{ mcpHost: builtins\.mcpHost \} : \{\}\),/);
});

test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /\.\.\.subagentExtensionLoaderOptions\(profile\)/);
  assert.match(subagentSource, /loadSkills: profile\.loadSkills/);
  assert.match(subagentSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(subagentSource, /withSubagentExtensionTools\(profile\.tools, extensionToolNames\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readSubagentSessionResources\(/);
  assert.match(startupSource, /resourceLoaderOptions: subagentResources/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /\.\.\.subagentExtensionLoaderOptions\(subagentResources\)/);
  assert.match(startupSource, /loadSkills: subagentResources\.loadSkills/);
  assert.match(startupSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(startupSource, /let toolsOption: string\[\] \| undefined = subagentResources\?\.tools/);
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\),[\s\S]*?isBuiltInSubagentsEnabled/);
  assert.match(startupSource, /preferPiWebSubagentExtension\(base\)/);
});

test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: \[\.\.\.scope\.scopedModels\]/);
  assert.match(startupSource, /model: startupModel/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = branch\.some\(\(entry\) => entry\.type === "message" && entry\.message\.role !== "system"\)/,
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

test("quoted branches use the independent atomic file service", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const forkSource = source.slice(source.indexOf('case "fork_branch"'), source.indexOf('case "clone"'));
  assert.match(forkSource, /selectedEntry\.message\.role !== "assistant"/);
  assert.match(forkSource, /createForkedSession\(currentSessionFile, entryId\)/);
  assert.doesNotMatch(forkSource, /createBranchedSession|SessionManager\.open/);
});

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");

test("fork_branch copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), selectedEntryId);
    assert.equal(manager.getLeafId(), selectedEntryId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork before the first message persists a reopenable message-free child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const settingsEntryId = manager.appendModelChange("test", "test-model");
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;

    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.equal(forked.getLeafId(), settingsEntryId);
    assert.deepEqual(forked.getEntries(), [manager.getEntry(settingsEntryId)]);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

function assistantFixture(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("fork and fork_branch copy finished entries while the source keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-running-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const firstAssistantId = manager.appendMessage(assistantFixture("first response"));
  // The turn the agent is still running: its user message is already on disk.
  const runningUserId = manager.appendMessage({ role: "user", content: "running prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const sourceBefore = await readFile(sourceFile, "utf8");
  const forkedFiles = [];
  let disposed = false;
  let shutdownEvents = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => { shutdownEvents += 1; } },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const forked = await wrapper.send({ type: "fork", entryId: runningUserId });
    const branched = await wrapper.send({ type: "fork_branch", entryId: firstAssistantId });
    const sessions = await SessionManager.list(root, sessionDir);
    for (const result of [forked, branched]) {
      const info = sessions.find((session) => session.id === result.newSessionId);
      assert.ok(info);
      forkedFiles.push(info.path);
      const child = SessionManager.open(info.path, sessionDir);
      assert.equal(child.getHeader().parentSession, sourceFile);
      assert.equal(child.getLeafId(), firstAssistantId);
      assert.deepEqual(child.getEntries().map((entry) => entry.id), [firstUserId, firstAssistantId]);
    }

    assert.equal(wrapper.isAlive(), true);
    assert.equal(disposed, false);
    assert.equal(shutdownEvents, 0);
    assert.equal(manager.getLeafId(), runningUserId);
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
  } finally {
    wrapper.destroy();
    for (const file of forkedFiles) await unlink(file);
    await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork refuses a running shell command and a source not yet written to disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unsaved-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendModelChange("test", "test-model");
  // pi 0.99 writes the file at the first user message. Remove it to exercise
  // the missing-on-disk error without relying on the old flush behavior.
  const userId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  await unlink(sourceFile);
  const inner = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: true,
    abortBash() {},
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );

    inner.isBashRunning = false;
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /has not been saved yet/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /has not been saved yet/,
    );
    assert.equal(wrapper.isAlive(), true);
    assert.deepEqual(await readdir(sessionDir), []);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("clone 拒绝运行中的会话，并在独立文件中复制答复而保留源 wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage(assistantFixture("fixture response"));
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");
  const sourceFile = manager.getSessionFile();
  const sourceBefore = await readFile(sourceFile, "utf8");
  let disposed = false;
  let shutdownEvents = 0;
  const inner = {
    sessionId: manager.getSessionId(), sessionFile: sourceFile, sessionManager: manager,
    isStreaming: true, isCompacting: false, isBashRunning: false,
    extensionRunner: { emit: async () => { shutdownEvents += 1; } },
    agent: { state: {} }, dispose() { disposed = true; },
  };
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await assert.rejects(wrapper.send({ type: "clone", leafId: cloneLeafId }), /Cannot clone while the session is running/);
    inner.isStreaming = false;
    const result = await wrapper.send({ type: "clone", leafId: cloneLeafId });
    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    const cloned = SessionManager.open(clonedInfo.path, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
    assert.equal(wrapper.isAlive(), true);
    assert.equal(disposed, false);
    assert.equal(shutdownEvents, 0);
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    // Since pi 0.99 the first user message already creates the source file.
    assert.deepEqual((await SessionManager.list(root, sessionDir)).map((session) => session.path), [sourceFile]);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
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

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("exact prompts are sent through before_agent_start instead of the SDK prompt state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );

  // Pi 0.86 replays agent.state.systemPrompt from the transcript: assigning it throws,
  // and the loop's request context no longer carries a systemPrompt field.
  assert.doesNotMatch(source, /state\.systemPrompt =/);
  assert.doesNotMatch(source, /prepareNextTurnWithContext/);
  assert.doesNotMatch(subagentSource, /state\.systemPrompt =/);
  assert.match(startupSource, /const exactSystemPromptExtension = createExactSystemPromptExtension\(\(\) => exactSystemPromptRef\.current\?\.\(\)\)/);
  assert.match(startupSource, /exactSystemPromptRef\.current = exactSystemPrompt;/);
  assert.match(startupSource, /\{ \.\.\.CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: \[exactSystemPromptExtension\] \}/);
  // Subagent projection now composes exact prompts and preloads in the shared binding;
  // actual provider input is covered in subagent-skills.integration.test.mjs.
  assert.match(startupSource, /\.\.\.skillsBinding!\.loaderOptions/);
  assert.match(subagentSource, /\.\.\.skillsBinding\.loaderOptions/);
  assert.match(promptSource, /preflightResult: \(\) => acceptPreflight\(\),/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});

test("RPC 新会话启动保留显式模型默认值写入边界", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /persistExplicitStartupPreferences/);
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
  assert.match(reloadSource, /await this\.fastSessionSetting\.restoreAfterRuntimeReset\(\);\s*invalidateModelsCache\(this\.cwd\)/);
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
  const dialogSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private createExtensionUiContext"),
  );

  assert.match(abortSource, /this\.aborting = true/);
  assert.ok(abortSource.indexOf("this.extensionUiAbortController.abort(") < abortSource.indexOf("this.inner.abort()"));
  assert.match(abortSource, /activeAskToolStarts\.clear\(\)/);
  assert.match(dialogSource, /const stopSignal = this\.extensionUiAbortController\.signal/);
  assert.match(dialogSource, /stopSignal\.aborted/);
  assert.match(dialogSource, /type: "extension_ui_closed"/);
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
  extensionSequence = firstQuestion.then(
    () => ui.select("第二题", ["C", "D"]),
    (error) => error,
  );

  await Promise.race([
    wrapper.send({ type: "abort" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort 超过 500ms 未返回")), 500)),
  ]);

  assert.equal((await extensionSequence).name, "AbortError");
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
