import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-compaction-queue-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const replies = (count) => Array.from({ length: count }, (_, i) => fauxAssistantMessage([fauxText(`reply ${i}`)]));

/**
 * A real AgentSession whose manual compaction holds in `session_before_compact`
 * until the test releases it, and whose `input` handler takes a while for the
 * text "slow", as an extension's async input handler can.
 */
async function compactingSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-compaction-queue-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const gate = { release: null };
  const extension = (pi) => {
    pi.on("session_before_compact", async (event) => {
      await new Promise((resolve) => { gate.release = resolve; });
      return {
        compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 10 },
      };
    });
    pi.on("input", async (event) => {
      if (event.text === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
      return { action: "continue" };
    });
  };
  const faux = fauxProvider({ models: [{ id: "faux-compaction-queue" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-compaction-queue"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  faux.setResponses(replies(2));
  await session.prompt("one");
  await session.prompt("two");
  const compaction = wrapper.send({ type: "compact" }).catch((error) => error);
  while (!gate.release) await tick();
  const sentAfterCompaction = () => session.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : message.content[0]?.text))
    .filter((text) => text !== "one" && text !== "two");
  const settle = async () => {
    for (let i = 0; i < 200 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick();
  };
  return { session, wrapper, faux, gate, events, compaction, sentAfterCompaction, settle };
}

test("prompts parked during a manual compaction go out in order, a slow input handler or not", async (t) => {
  const { wrapper, faux, gate, events, compaction, sentAfterCompaction, settle } = await compactingSession(t);

  assert.deepEqual(await wrapper.send({ type: "prompt", message: "slow" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "fast", streamingBehavior: "steer" }), { queued: true });
  // Rows in arrival order: a plain parked prompt is a steer, as the TUI parks Enter.
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [{ text: "slow", images: [] }, { text: "fast", images: [] }], followUp: [] });
  assert.equal(wrapper.isRunning(), true);

  faux.setResponses(replies(4));
  gate.release();
  await compaction;
  await settle();

  // Each delivery goes through the admission chain: "fast" never overtakes "slow".
  assert.deepEqual(sentAfterCompaction(), ["slow", "fast"]);
  assert.deepEqual(events.filter((event) => event.type === "prompt_error"), []);
  assert.ok(events.some((event) => event.type === "prompt_done"));
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
});

test("Stop during a manual compaction returns the parked prompts instead of sending them", async (t) => {
  const { wrapper, faux, gate, events, compaction, sentAfterCompaction, settle } = await compactingSession(t);

  await wrapper.send({ type: "prompt", message: "parked" });
  faux.setResponses(replies(2));
  const stopped = wrapper.send({ type: "abort" });
  await tick();
  gate.release();
  assert.deepEqual(await stopped, { steering: [{ text: "parked", images: [] }], followUp: [] });
  assert.match(String((await compaction)?.message), /cancelled/i);
  await settle();

  assert.deepEqual(sentAfterCompaction(), []);
  assert.equal(wrapper.isRunning(), false);
  assert.ok(events.some((event) => event.type === "prompt_done" && event.aborted === true));
});

test("Recall during the flush takes back a parked prompt still waiting for its turn", async (t) => {
  const { wrapper, faux, gate, compaction, sentAfterCompaction, settle } = await compactingSession(t);

  await wrapper.send({ type: "prompt", message: "slow" });
  await wrapper.send({ type: "prompt", message: "fast", streamingBehavior: "steer" });
  faux.setResponses(replies(4));
  gate.release();
  await compaction;
  await tick();
  // "slow" is in its input handler; "fast" waits behind it and is still a queue row.
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [{ text: "fast", images: [] }], followUp: [] });
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), { steering: [{ text: "fast", images: [] }], followUp: [] });
  await settle();

  assert.deepEqual(sentAfterCompaction(), ["slow"]);
  assert.equal(wrapper.isRunning(), false);
});

test("a refusal that lands after the compaction ended is sent, not left parked", async (t) => {
  // The SDK refuses during compaction, but the wrapper's rejection handler runs a
  // microtask later: compaction_end may have flushed already. Try every interleaving.
  for (let hops = 0; hops < 40; hops += 1) {
    const { wrapper, faux, gate, compaction, sentAfterCompaction, settle } = await compactingSession(t);
    faux.setResponses(replies(2));
    const ack = wrapper.send({ type: "prompt", message: "racer" });
    for (let i = 0; i < hops; i += 1) await Promise.resolve();
    gate.release();
    await ack;
    await compaction;
    await settle();
    assert.deepEqual(sentAfterCompaction(), ["racer"], `after ${hops} hops`);
    assert.equal(wrapper.isRunning(), false, `after ${hops} hops`);
    wrapper.destroy();
  }
});

test("Stop returns pi's own queued follow-up instead of leaving it stuck", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-stop-queue-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-stop-queue" }], tokensPerSecond: 20 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-stop-queue"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  faux.setResponses([fauxAssistantMessage([fauxText("long reply ".repeat(200))]), fauxAssistantMessage([fauxText("must not run")])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 200 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);
  await wrapper.send({ type: "prompt", message: "next", streamingBehavior: "followUp" });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages.followUp, [{ text: "next", images: [] }]);

  assert.deepEqual(await wrapper.send({ type: "abort" }), { steering: [], followUp: [{ text: "next", images: [] }] });

  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
  assert.ok(events.some((event) => event.type === "queue_update" && event.followUp?.length === 0));
  await tick();
  const sent = session.messages.filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : message.content[0]?.text));
  assert.deepEqual(sent, ["first"]);
});

/** A real session whose extension holds session_start until released, as a slow index does. */
async function slowBindingSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-first-prompt-cwd-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-first-prompt-sessions-"));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));
  const gate = { release: null };
  const extension = (pi) => {
    pi.on("session_start", () => new Promise((resolve) => { gate.release = resolve; }));
  };
  const faux = fauxProvider({ models: [{ id: "faux-first-prompt" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-first-prompt"),
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  while (!gate.release) await tick();
  const userTexts = () => session.messages.filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : message.content[0]?.text));
  return { session, wrapper, faux, gate, userTexts };
}

test("the server holds a new session's first prompt until a slow binding ends", async (t) => {
  const { session, wrapper, faux, gate, userTexts } = await slowBindingSession(t);
  faux.setResponses(replies(1));
  let prepared = 0;
  const prepare = async () => { prepared += 1; };

  wrapper.submitFirstPrompt({ message: "hello", prepare });
  // Answered at once: the file exists, so the session is listed while extensions still bind.
  assert.equal(existsSync(session.sessionFile), true);
  assert.equal(wrapper.startingFirstPrompt, "hello");
  assert.equal(wrapper.isRunning(), true);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [{ text: "hello", images: [] }], followUp: [] });

  // A retry after a lost response sends nothing twice.
  wrapper.submitFirstPrompt({ message: "hello", prepare });
  await tick();
  assert.equal(prepared, 0);
  assert.deepEqual(userTexts(), []);

  gate.release();
  for (let i = 0; i < 200 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick();

  assert.equal(prepared, 1);
  assert.deepEqual(userTexts(), ["hello"]);
  assert.equal(wrapper.startingFirstPrompt, null);
  assert.equal(wrapper.diskFreshness(), "current");
  assert.match(readFileSync(session.sessionFile, "utf8"), /hello/);
});

test("Stop while the first prompt waits returns it unsent", async (t) => {
  const { session, wrapper, faux, gate, userTexts } = await slowBindingSession(t);
  faux.setResponses(replies(1));
  wrapper.submitFirstPrompt({ message: "hello", prepare: async () => {} });

  const stopped = wrapper.send({ type: "abort" });
  await tick();
  gate.release();
  assert.deepEqual(await stopped, { steering: [{ text: "hello", images: [] }], followUp: [] });
  for (let i = 0; i < 50 && !session.isIdle; i += 1) await tick();
  await tick();

  assert.deepEqual(userTexts(), []);
  assert.equal(wrapper.startingFirstPrompt, null);
  assert.equal(wrapper.isRunning(), false);
});

async function streamingSession(t, modelId) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-stop-wake-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: modelId }], tokensPerSecond: 20 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(modelId),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  faux.setResponses([fauxAssistantMessage([fauxText("long reply ".repeat(200))]), fauxAssistantMessage([fauxText("must not run")])]);
  let replying = false;
  wrapper.onEvent((event) => { if (event.type === "message_update") replying = true; });
  await wrapper.send({ type: "prompt", message: "first" });
  // Past the loop's opening steering poll: the reply is streaming.
  for (let i = 0; i < 200 && !replying; i += 1) await tick();
  assert.equal(session.isStreaming, true);
  return { session, wrapper };
}

function keptWakes(session) {
  return session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "pi-web:background-command");
}

test("Stop keeps a queued wake message in the session without starting a turn", async (t) => {
  const { session, wrapper } = await streamingSession(t, "faux-stop-wake");
  void session.sendCustomMessage(
    { customType: "pi-web:background-command", content: "build exited with code 2", display: true, details: { commandId: "abc" } },
    { deliverAs: "followUp", triggerTurn: true },
  );
  await tick();
  assert.equal(keptWakes(session).length, 0);

  assert.equal(await wrapper.send({ type: "abort" }), null);
  await tick();

  const kept = keptWakes(session);
  assert.equal(kept.length, 1);
  assert.match(kept[0].content, /build exited with code 2[\s\S]*pressed Stop/);
  assert.deepEqual(kept[0].details, { commandId: "abc", keptAfter: "stop" });
  assert.equal(session.isStreaming, false);
  assert.ok(!session.messages.some((message) => message.role === "assistant"
    && JSON.stringify(message.content).includes("must not run")));
});

test("Clearing the queue keeps a wake message, appended once the turn ends", async (t) => {
  const { session, wrapper } = await streamingSession(t, "faux-clear-wake");
  void session.sendCustomMessage(
    { customType: "pi-web:scheduled-task", content: "check CI", display: true },
    { deliverAs: "steer", triggerTurn: true },
  );
  await tick();
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), { steering: [], followUp: [] });
  await wrapper.send({ type: "abort" });
  await tick();
  const kept = session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "pi-web:scheduled-task");
  assert.equal(kept.length, 1);
  assert.match(kept[0].content, /check CI[\s\S]*cleared the queue/);
});
