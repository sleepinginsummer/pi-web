import assert from "node:assert/strict";
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

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-command-queue-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A real AgentSession whose extension registers `/slow`, a command that holds
 * until the test releases it — the shape of `/review`, which awaits an
 * independent model call and starts no run of its own.
 */
async function commandSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-command-queue-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let commandRuns = 0;
  const extension = (pi) => {
    pi.registerCommand("slow", {
      description: "holds until released",
      handler: async () => {
        commandRuns += 1;
        started.resolve();
        await gate.promise;
      },
    });
  };
  const faux = fauxProvider({ models: [{ id: "faux-command-queue" }], tokensPerSecond: 40 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
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
    model: faux.getModel("faux-command-queue"),
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
  const userTexts = () => session.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.text ?? "").join("")));
  const settle = async () => {
    for (let i = 0; i < 900 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick();
    assert.equal(wrapper.isRunning(), false, "the session settles");
    assert.equal(session.isIdle, true, "the SDK run settles");
  };
  return { session, wrapper, faux, events, userTexts, settle, commandStarted: started.promise, commandRuns: () => commandRuns, releaseCommand: gate.resolve };
}

test("the command's own submission is acknowledged when pi dispatches it", async (t) => {
  const { wrapper, commandStarted, releaseCommand, settle } = await commandSession(t);

  let acknowledged = false;
  const command = wrapper.send({ type: "prompt", message: "/slow" })
    .then((value) => { acknowledged = true; return value; });
  await commandStarted;
  await tick();
  assert.equal(acknowledged, true, "a command that is still running must not hold the POST open");
  assert.equal(wrapper.isRunning(), true, "the session is busy while the command runs");

  releaseCommand();
  assert.equal(await command, null);
  await settle();
  assert.equal(wrapper.isRunning(), false);
});

test("a message queued while an extension command runs still reaches the model", async (t) => {
  const { wrapper, session, faux, events, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t);

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.equal(session.isStreaming, false, "an extension command starts no run of its own");

  // The composer's steer button while only the command runs: pi's steering queue
  // has no consumer here, so the message has to become a run of its own.
  faux.setResponses([fauxAssistantMessage([fauxText("answered while the review ran")])]);
  assert.equal(await wrapper.send({ type: "steer", message: "后续消息" }), null);

  for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
  assert.deepEqual(userTexts(), ["后续消息"], "the message went out as its own turn");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
  assert.ok(events.some((event) => event.type === "agent_start"));
  for (let i = 0; i < 300 && !JSON.stringify(session.messages.at(-1)?.content ?? "").includes("answered while the review ran"); i += 1) await tick();
  assert.match(JSON.stringify(session.messages.at(-1)?.content ?? ""), /answered while the review ran/);

  releaseCommand();
  await command;
  await settle();
  assert.equal(wrapper.isRunning(), false);
});

test("a follow-up sent while a turn streams still queues into that turn", async (t) => {
  const { wrapper, session, faux, userTexts, settle } = await commandSession(t);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("queued answer")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);

  assert.equal(await wrapper.send({ type: "follow_up", message: "后续消息" }), null);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "后续消息", images: [] }],
  });

  await settle();
  assert.deepEqual(userTexts(), ["first", "后续消息"]);
  assert.match(JSON.stringify(session.messages.at(-1)?.content ?? ""), /queued answer/);
  assert.equal(wrapper.isRunning(), false);
});

test("a follow-up extension command waits for the turn and is delivered after it", async (t) => {
  const { wrapper, session, faux, commandRuns, commandStarted, releaseCommand, settle } = await commandSession(t);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("answer to the queued message")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);

  // The composer's follow-up button: pi would run the command right now, the wrapper holds it.
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow", streamingBehavior: "followUp" }), { queued: true });
  assert.equal(commandRuns(), 0, "the command has not started while the turn runs");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [{ text: "/slow", images: [] }] });

  // The turn ends, the parked command goes, and the label names it meanwhile.
  for (let i = 0; i < 400 && commandRuns() === 0; i += 1) await tick();
  assert.equal(commandRuns(), 1, "the command starts once the turn is over");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });

  releaseCommand();
  await commandStarted;
  await settle();
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, []);
  assert.equal(wrapper.isRunning(), false);
});

test("Stop takes a queued follow-up command back instead of running it", async (t) => {
  const { wrapper, session, faux, commandRuns, settle } = await commandSession(t);

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  await wrapper.send({ type: "prompt", message: "/slow", streamingBehavior: "followUp" });

  assert.deepEqual(await wrapper.send({ type: "abort" }), { steering: [], followUp: [{ text: "/slow", images: [] }] });
  await settle();
  assert.equal(commandRuns(), 0, "the recalled command never ran");
});

test("Stop says an extension command cannot be interrupted instead of pretending", async (t) => {
  const { wrapper, commandStarted, releaseCommand, settle } = await commandSession(t);

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.equal(wrapper.isRunning(), true);

  assert.deepEqual(await wrapper.send({ type: "abort" }), { blockedByCommands: ["/slow"] });
  assert.equal(wrapper.isRunning(), true, "the command keeps running after Stop");

  releaseCommand();
  await command;
  await settle();
  assert.equal(wrapper.isRunning(), false);
});

test("a delivered parked command releases prompt admission while it runs", async (t) => {
  const { wrapper, session, faux, commandRuns, releaseCommand, settle } = await commandSession(t);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("second reply")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);

  // 排队 → 本轮结束后投递，命令开始运行。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow", streamingBehavior: "followUp" }), { queued: true });
  for (let i = 0; i < 400 && commandRuns() === 0; i += 1) await tick();
  assert.equal(commandRuns(), 1, "the parked command started");

  // 命令还在跑：下一条 prompt 仍要能被受理。修复前它会卡在 promptAdmissionTail 上，
  // 连命令自己的 cancel 都进不来。
  let admitted = false;
  const next = wrapper.send({ type: "prompt", message: "while the command runs" })
    .then((value) => { admitted = true; return value; });
  for (let i = 0; i < 100 && !admitted; i += 1) await tick();
  assert.equal(admitted, true, "a parked command must not hold prompt admission");

  releaseCommand();
  await next;
  await settle();
  assert.equal(commandRuns(), 1);
});

test("a follow-up command waits for the turn even while another command runs", async (t) => {
  const { wrapper, session, faux, commandRuns, commandStarted, releaseCommand, settle } = await commandSession(t);

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);

  // 直接提交：pi 立刻执行命令，此时本轮仍在流式输出。
  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.equal(commandRuns(), 1);
  assert.equal(session.isStreaming, true);

  // 「后续」：回合还在跑，所以等回合结束，不因为已有命令在跑就插队执行。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow", streamingBehavior: "followUp" }), { queued: true });
  await tick();
  await tick();
  assert.equal(commandRuns(), 1, "the queued command must not jump ahead of the turn");

  releaseCommand();
  await running;
  for (let i = 0; i < 400 && commandRuns() < 2; i += 1) await tick();
  assert.equal(commandRuns(), 2, "it runs once the turn is over");
  await settle();
});
