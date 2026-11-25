import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const { SubmitGuard, createSubmitGuardExtension } = await jiti.import("./submit-guard.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A real AgentSession whose extension registers `/slow`, a command that holds
 * until the test releases it — the shape of `/review`, which awaits an
 * independent model call and starts no run of its own. `afterRelease` runs
 * last, inside the handler: a command that sends a message with `triggerTurn`
 * starts a run of its own before it returns, as `/review`'s report can. `holdInput`
 * is a text whose SDK `input` hook holds until the test releases it, the shape of
 * a slow extension input handler between dispatch and pi accepting the prompt.
 */
async function commandSession(t, {
  afterRelease,
  persisted = false,
  holdInput,
  skills = [],
  submitGuard = false,
  transformInput,
  onCommand,
  onAgentSettled,
  handleInput,
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-command-queue-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // 落盘会话才有时钟外的文件可被别的进程改写（内存会话的 diskFreshness 恒为 current）。
  const sessionDir = persisted ? await mkdtemp(join(tmpdir(), "pi-web-command-queue-sessions-")) : null;
  if (sessionDir) t.after(() => rm(sessionDir, { recursive: true, force: true }));
  // 技能真的落一份 SKILL.md：`expandMultiSkillCommand` 会同步读它，文件消失时抛错。
  const skillFiles = [];
  for (const name of skills) {
    const dir = join(cwd, "skills", name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    await writeFile(file, `---\nname: ${name}\ndescription: temporary skill for tests\n---\n\nbody of ${name}\n`);
    skillFiles.push({ name, path: file });
  }
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const holdTexts = [...new Set(Array.isArray(holdInput) ? holdInput : holdInput ? [holdInput] : [])];
  const inputWaiters = new Map(holdTexts.map((text) => [text, { started: Promise.withResolvers(), gate: Promise.withResolvers() }]));
  let commandRuns = 0;
  const extension = (pi) => {
    if (inputWaiters.size > 0) {
      pi.on("input", async (event) => {
        const waiter = inputWaiters.get(event.text);
        if (waiter) {
          waiter.started.resolve();
          await waiter.gate.promise;
        }
        return { action: "continue" };
      });
    }
    // 改写正文的 `input` 钩子：守闸随后看到的是 `to`，不是派发时的原文。
    if (transformInput) {
      pi.on("input", (event) => (event.text === transformInput.from
        ? { action: "transform", text: transformInput.to }
        : undefined));
    }
    if (onAgentSettled) {
      pi.on("agent_settled", async () => {
        await onAgentSettled();
      });
    }
    if (handleInput) {
      pi.on("input", (event) => (event.text === handleInput ? { action: "handled" } : undefined));
    }
    pi.registerCommand("slow", {
      description: "holds until released",
      handler: async (args) => {
        commandRuns += 1;
        started.resolve();
        if (onCommand) {
          await onCommand(args, pi);
          return;
        }
        await gate.promise;
        afterRelease?.(pi);
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
  // `submitGuard` 复刻生产装配：守闸的内联扩展排在最后，运行在 pi 的 `input` 钩子最后一道。
  const guard = submitGuard ? new SubmitGuard() : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: guard
      ? [extension, createSubmitGuardExtension(() => guard)]
      : [extension],
    // `skills` 会真的写一份 SKILL.md 并交给加载器：用来测「技能文件在等待期间消失」。
    noSkills: skillFiles.length === 0,
    ...(skillFiles.length ? { additionalSkillPaths: skillFiles.map((file) => file.path) } : {}),
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
    sessionManager: sessionDir ? SessionManager.create(cwd, sessionDir) : SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = guard
    ? new AgentSessionWrapper(session, new Set(), "initial", { submitGuard: guard })
    : new AgentSessionWrapper(session);
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
  return {
    session,
    wrapper,
    faux,
    events,
    userTexts,
    settle,
    commandStarted: started.promise,
    commandRuns: () => commandRuns,
    releaseCommand: gate.resolve,
    cwd,
    skillFiles,
    inputHeld: (text) => inputWaiters.get(text)?.started.promise ?? Promise.resolve(),
    releaseInput: (text) => inputWaiters.get(text)?.gate.resolve(),
  };
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

for (const submission of [
  { label: "a plain send", command: { type: "prompt", message: "后续消息" }, group: "steering" },
  { label: "the steer button", command: { type: "steer", message: "后续消息" }, group: "steering" },
  { label: "the follow-up button", command: { type: "follow_up", message: "后续消息" }, group: "followUp" },
]) {
  test(`${submission.label} while an extension command runs waits for the command`, async (t) => {
    const { wrapper, session, faux, events, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t);

    const command = wrapper.send({ type: "prompt", message: "/slow" });
    await commandStarted;
    assert.equal(session.isStreaming, false, "an extension command starts no run of its own");

    // 命令跑着时没有回合可入队：pi 会直接另起一轮，和仍在执行的 /review 并行。
    // 消息应当成为排队行，等命令结束再发。
    faux.setResponses([fauxAssistantMessage([fauxText("answered after the review")])]);
    assert.deepEqual(await wrapper.send(submission.command), { queued: true });
    await tick();
    await tick();
    assert.deepEqual(userTexts(), [], "the message waits for the command to finish");
    assert.equal(events.some((event) => event.type === "agent_start"), false, "nothing starts beside the command");
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
      steering: submission.group === "steering" ? [{ text: "后续消息", images: [] }] : [],
      followUp: submission.group === "followUp" ? [{ text: "后续消息", images: [] }] : [],
    });

    releaseCommand();
    await command;
    for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
    assert.deepEqual(userTexts(), ["后续消息"], "the message goes out once the command returns");
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
    await settle();
    assert.equal(wrapper.isRunning(), false);
    assert.match(JSON.stringify(session.messages.at(-1)?.content ?? ""), /answered after the review/);
  });
}

test("a command sent while another command runs still goes straight to its handler", async (t) => {
  const { wrapper, commandRuns, commandStarted, releaseCommand, settle } = await commandSession(t);

  const first = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  // `/review cancel` 必须立刻到达处理器：命令不能排队，否则取消永远等不到命令结束。
  const second = wrapper.send({ type: "prompt", message: "/slow" });
  for (let i = 0; i < 300 && commandRuns() < 2; i += 1) await tick();
  assert.equal(commandRuns(), 2, "the command is dispatched beside the running one");

  releaseCommand();
  await Promise.all([first, second]);
  await settle();
  assert.equal(wrapper.isRunning(), false);
});

for (const submission of [
  { label: "a follow-up", command: { type: "follow_up", message: "后续消息" }, group: "followUp" },
  { label: "a steer", command: { type: "steer", message: "后续消息" }, group: "steering" },
]) {
  test(`${submission.label} submitted mid-run waits for the command the run started`, async (t) => {
    const { wrapper, session, faux, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t);

    faux.setResponses([
      fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
      fauxAssistantMessage([fauxText("answer after the review")]),
    ]);
    await wrapper.send({ type: "prompt", message: "first" });
    for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
    assert.equal(session.isStreaming, true);

    // 「引导」启动 /review：命令立刻执行，回合继续流式输出。
    const running = wrapper.send({ type: "prompt", message: "/slow" });
    await commandStarted;
    assert.equal(session.isStreaming, true);

    // 命令还在跑：pi 的下一批次会在命令结束前就把它消费掉，所以必须排队而不是入队。
    assert.deepEqual(await wrapper.send(submission.command), { queued: true });
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
      steering: submission.group === "steering" ? [{ text: "后续消息", images: [] }] : [],
      followUp: submission.group === "followUp" ? [{ text: "后续消息", images: [] }] : [],
    });

    // 回合结束、命令仍在跑：消息不能被这一轮或新一轮提前消费。
    for (let i = 0; i < 900 && session.isStreaming; i += 1) await tick();
    assert.equal(session.isStreaming, false);
    await tick();
    await tick();
    assert.deepEqual(userTexts(), ["first"], "the run must not answer it while the review runs");

    releaseCommand();
    await running;
    for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
    assert.deepEqual(userTexts(), ["first", "后续消息"], "it goes out once the command returns");
    await settle();
  });
}

test("a message held behind a command goes after the run that command starts", async (t) => {
  const { wrapper, session, faux, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t, {
    // /review 带回 continue_dialogue 的形态：处理器返回之前自己起一轮。
    afterRelease: (pi) => pi.sendMessage(
      { customType: "review-report", content: "审查报告", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    ),
  });

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  faux.setResponses([
    fauxAssistantMessage([fauxText("report reply ".repeat(40))]),
    fauxAssistantMessage([fauxText("answer to the held message")]),
  ]);
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "后续消息" }), { queued: true });

  releaseCommand();
  await command;
  // 命令起的那轮先跑：消息不能插到它前面并行开一轮。
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true, "the report run is the one that goes first");
  assert.deepEqual(userTexts(), [], "the held message still waits");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "后续消息", images: [] }],
    followUp: [],
  });

  await settle();
  assert.deepEqual(userTexts(), ["后续消息"], "it goes once the report's run is over");
  const order = session.messages.map((message) => message.role);
  assert.ok(order.indexOf("custom") < order.indexOf("user"), "the report comes before the held message");
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

  // 命令停不了；没有排队消息时交还的是两个空列表，前端只显示提示。
  assert.deepEqual(await wrapper.send({ type: "abort" }), { blockedByCommands: ["/slow"], steering: [], followUp: [] });
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

test("a follow-up command waits for a running command even after the turn ends", async (t) => {
  const { wrapper, session, faux, commandRuns, commandStarted, releaseCommand, settle } = await commandSession(t);

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);

  // 回合中直接提交：命令立刻执行并一直跑着，回合结束时它还没返回。
  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.equal(session.isStreaming, true);
  // 「后续」：要等当前回合与在跑的命令都结束后再执行，不会并发撞上正在跑的命令。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });

  for (let i = 0; i < 900 && session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, false);
  await tick();
  await tick();
  assert.equal(commandRuns(), 1, "the follow-up command still waits while the earlier command runs");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "/slow second", images: [] }],
  });

  releaseCommand();
  await running;
  for (let i = 0; i < 400 && commandRuns() < 2; i += 1) await tick();
  assert.equal(commandRuns(), 2, "the follow-up command is dispatched once the earlier command returns");
  assert.equal((await wrapper.send({ type: "get_state" })).queuedMessages.followUp.length, 0);
  await settle();
});

test("follow-up commands sent while a command runs stay visible in the queue and run serially", async (t) => {
  const gates = [];
  const startedArgs = [];
  const { wrapper, events, commandRuns, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
  });

  await wrapper.send({ type: "prompt", message: "/slow first" });
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first"]);

  // 命令单独运行中（无流式回合）连发两条「后续」命令：都要进队列并广播 queue_update，不能并发执行。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow third", streamingBehavior: "followUp" }), { queued: true });
  await tick();
  assert.equal(commandRuns(), 1, "queued follow-up commands must not run beside the active command");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [
      { text: "/slow second", images: [] },
      { text: "/slow third", images: [] },
    ],
  });
  assert.deepEqual(
    events.filter((event) => event.type === "queue_update").at(-1)?.followUp,
    [
      { text: "/slow second", images: [] },
      { text: "/slow third", images: [] },
    ],
  );

  // 「引导」提交（如 `/review cancel`）仍立刻到达处理器，不被队列挡住。
  await wrapper.send({ type: "prompt", message: "/slow cancel", streamingBehavior: "steer" });
  for (let i = 0; i < 300 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "cancel"]);
  gates[1].resolve();
  await tick();

  // 第一个结束后只派发第二个，第三个仍留在队列里等待。
  gates[0].resolve();
  for (let i = 0; i < 300 && gates.length < 3; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "cancel", "second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "/slow third", images: [] }],
  });

  // 第二个结束后才派发第三个。
  gates[2].resolve();
  for (let i = 0; i < 300 && gates.length < 4; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "cancel", "second", "third"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });

  gates[3].resolve();
  await settle();
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, []);
});

test("follow-up user messages cannot overtake a parked follow-up extension command", async (t) => {
  const gates = [];
  const startedArgs = [];
  const { wrapper, session, faux, userTexts, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
  });

  await wrapper.send({ type: "prompt", message: "/slow first" });
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();

  // 命令运行期间依次排入：普通后续 A、扩展命令后续 B、普通后续 C。
  faux.setResponses([
    fauxAssistantMessage([fauxText("A reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("C reply")]),
    fauxAssistantMessage([fauxText("D reply")]),
  ]);
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "A" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "C" }), { queued: true });

  // 第一个命令结束：A 开启模型回合；B 因回合流式输出留在队列，C 也必须留在 B 后面，不能越过 B 进 SDK 队列。
  gates[0].resolve();
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  assert.equal(session.isStreaming, true);
  await tick();
  await tick();
  assert.deepEqual(userTexts(), ["A"]);
  assert.deepEqual(startedArgs, ["first"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [
      { text: "/slow second", images: [] },
      { text: "C", images: [] },
    ],
  });

  // 回合进行中再发普通后续 D：同样排在 B 与 C 后面；「引导」命令仍立刻直达处理器。
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "D" }), { queued: true });
  await wrapper.send({ type: "prompt", message: "/slow cancel", streamingBehavior: "steer" });
  for (let i = 0; i < 300 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "cancel"]);
  gates[1].resolve();

  // A 结束后先跑 B（此时 C、D 仍未进入会话），B 结束后才依次执行 C、D。
  for (let i = 0; i < 900 && gates.length < 3; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "cancel", "second"]);
  assert.deepEqual(userTexts(), ["A"], "C and D must not run before /slow second");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [
      { text: "C", images: [] },
      { text: "D", images: [] },
    ],
  });

  gates[2].resolve();
  await settle();
  assert.deepEqual(userTexts(), ["A", "C", "D"]);
});

test("a parked follow-up command waits until SDK agent_settled completes before dispatching", async (t) => {
  const gates = [];
  const startedArgs = [];
  let settledHookEntered = Promise.withResolvers();
  let settledHookGate = Promise.withResolvers();
  let holdNextSettled = true;
  const { wrapper, session, faux, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
    onAgentSettled: async () => {
      if (!holdNextSettled) return;
      holdNextSettled = false;
      settledHookEntered.resolve();
      await settledHookGate.promise;
    },
  });

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  await wrapper.send({ type: "prompt", message: "/slow first" });
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });

  // 等回合结束并进入异步 agent_settled 扩展钩子：此时 session.isStreaming 已为 false，但 SDK 仍处于 _isEmittingAgentSettled。
  await settledHookEntered.promise;
  assert.equal(session.isStreaming, false);

  // 此时第一个命令结束：不能在 agent_settled 钩子完成前派发 /slow second，否则会掉进 SDK 延迟执行并丢失运行状态。
  gates[0].resolve();
  await tick();
  await tick();
  assert.deepEqual(startedArgs, ["first"], "/slow second must stay parked while agent_settled hook runs");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "/slow second", images: [] }],
  });

  // 放行 agent_settled 钩子后，/slow second 才真正出队执行并保持在 runningCommands 中直到它自己结束。
  settledHookGate.resolve();
  for (let i = 0; i < 300 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });

  gates[1].resolve();
  await settle();
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, []);
});

test("Stop while waiting for SDK agent_settled recalls the parked follow-up command without later execution", async (t) => {
  const gates = [];
  const startedArgs = [];
  const settledHookEntered = Promise.withResolvers();
  const settledHookGate = Promise.withResolvers();
  let holdNextSettled = true;
  const { wrapper, session, faux, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
    onAgentSettled: async () => {
      if (!holdNextSettled) return;
      holdNextSettled = false;
      settledHookEntered.resolve();
      await settledHookGate.promise;
    },
  });

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  await wrapper.send({ type: "prompt", message: "/slow first" });
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });

  await settledHookEntered.promise;
  gates[0].resolve();
  await tick();
  await tick();

  // 在 agent_settled 钩子完成前按 Stop：能取回 /slow second，放行钩子后也不会偷偷执行。
  const recalled = await wrapper.send({ type: "abort" });
  assert.deepEqual(recalled, { steering: [], followUp: [{ text: "/slow second", images: [] }] });

  settledHookGate.resolve();
  await tick();
  await tick();
  await settle();
  assert.deepEqual(startedArgs, ["first"]);
});

test("a follow-up waiting on prompt admission cannot overtake an already-parked follow-up command", async (t) => {
  const gates = [];
  const startedArgs = [];
  const { wrapper, session, faux, userTexts, inputHeld, releaseInput, settle } = await commandSession(t, {
    holdInput: "blocker",
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
  });

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("blocker reply")]),
    fauxAssistantMessage([fauxText("after reply")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  // 先排好一条扩展命令后续 `/slow first`。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow first", streamingBehavior: "followUp" }), { queued: true });

  // 再用一条卡在异步 input 钩子里的引导提交占住提交锁。
  const blocker = wrapper.send({ type: "steer", message: "blocker" });
  await inputHeld("blocker");

  // 占锁期间新来的「后续」命令和普通「后续」都在提交锁上排队，且排在即将到来的 agent_settled flush 之前。
  const secondCmd = wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" });
  const afterMsg = wrapper.send({ type: "follow_up", message: "after" });

  // 回合在锁释放前结束：放行 blocker 后，secondCmd / afterMsg 先拿到提交锁，但不得越过 `/slow first`。
  for (let i = 0; i < 900 && session.isStreaming; i += 1) await tick();
  await tick();
  await tick();
  releaseInput("blocker");
  await blocker;
  assert.deepEqual(await secondCmd, { queued: true });
  assert.deepEqual(await afterMsg, { queued: true });

  // 等 blocker 开启的回合结束，最先跑的扩展命令必须是 `/slow first`，`/slow second` 与 `after` 在队列中等待。
  for (let i = 0; i < 900 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first"]);
  assert.equal(userTexts().includes("after"), false, "after must not overtake /slow first");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [
      { text: "/slow second", images: [] },
      { text: "after", images: [] },
    ],
  });

  gates[0].resolve();
  for (let i = 0; i < 300 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "second"]);
  assert.equal(userTexts().includes("after"), false, "after must wait for /slow second");

  gates[1].resolve();
  await settle();
  assert.equal(userTexts().at(-1), "after");
});

test("a steer command sent during SDK agent_settled keeps its running state and blocks follow-up commands", async (t) => {
  const gates = [];
  const startedArgs = [];
  const settledHookEntered = Promise.withResolvers();
  const settledHookGate = Promise.withResolvers();
  let holdNextSettled = true;
  const { wrapper, session, faux, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
    onAgentSettled: async () => {
      if (!holdNextSettled) return;
      holdNextSettled = false;
      settledHookEntered.resolve();
      await settledHookGate.promise;
    },
  });

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  // 等回合进入异步 agent_settled 扩展钩子。
  await settledHookEntered.promise;
  assert.equal(session.isStreaming, false);

  // 先用「后续」排 second，再用「引导」发 first：两者都由 wrapper 暂存，且引导排在后续前面。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow second", streamingBehavior: "followUp" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow first", streamingBehavior: "steer" }), { queued: true });
  assert.deepEqual(startedArgs, []);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "/slow first", images: [] }],
    followUp: [{ text: "/slow second", images: [] }],
  });

  // 放行 agent_settled 钩子：先启动 `/slow first`，并保留在 runningCommands 里挡住 `/slow second`。
  settledHookGate.resolve();
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  await tick();
  await tick();
  assert.deepEqual(startedArgs, ["first"], "steer command runs first and second must not run concurrently");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow first"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "/slow second", images: [] }],
  });

  // 第一条真正返回后，第二条才启动。
  gates[0].resolve();
  for (let i = 0; i < 300 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "second"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow second"]);

  gates[1].resolve();
  await settle();
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, []);
});

test("a follow-up sent after the command ends goes behind the one that waited", async (t) => {
  const { wrapper, session, faux, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
    fauxAssistantMessage([fauxText("B answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "A" }), { queued: true });

  // 命令先结束，主回合仍在流式输出：A 还留在队列里等回合结算。
  releaseCommand();
  await running;
  await tick();
  assert.equal(session.isStreaming, true);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages.followUp.map((message) => message.text), ["A"]);

  // 后发的 B 不能直接进 pi 的队列抢在 A 前面。
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "B" }), { queued: true });
  assert.deepEqual(
    (await wrapper.send({ type: "get_state" })).queuedMessages.followUp.map((message) => message.text),
    ["A", "B"],
    "the later message must queue behind the waiting one",
  );

  await settle();
  assert.deepEqual(userTexts(), ["first", "A", "B"], "the model must get them in submission order");
});

test("a follow-up submitted while a parked message is dispatching goes after it", async (t) => {
  const { wrapper, session, faux, userTexts, commandStarted, releaseCommand, settle, inputHeld, releaseInput }
    = await commandSession(t, { holdInput: "B" });

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
    fauxAssistantMessage([fauxText("B answered")]),
    fauxAssistantMessage([fauxText("C answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "A" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "B" }), { queued: true });
  releaseCommand();
  await running;

  // 回合结束 → A 开新回合（已在流式输出），B 交给 pi 后停在自己的 input 钩子里。
  await inputHeld("B");

  // B 已离开队列但 pi 还没接收它：C 不能在这个时候直接进 pi 的队列。
  let cAcknowledged = false;
  const sendingC = wrapper.send({ type: "follow_up", message: "C" }).then((value) => {
    cAcknowledged = true;
    return value;
  });
  await tick();
  await tick();
  assert.equal(cAcknowledged, false, "C must wait for the message still inside pi's input hook");

  releaseInput("B");
  await sendingC;
  await settle();
  assert.deepEqual(userTexts(), ["first", "A", "B", "C"], "the dispatching message keeps its place");
});

test("a message submitted after the lock is taken still waits for its holder", async (t) => {
  const { wrapper, session, faux, userTexts, commandStarted, releaseCommand, settle, inputHeld, releaseInput }
    = await commandSession(t, { holdInput: ["B", "C"] });

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
    fauxAssistantMessage([fauxText("B answered")]),
    fauxAssistantMessage([fauxText("C answered")]),
    fauxAssistantMessage([fauxText("D answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "A" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "B" }), { queued: true });
  releaseCommand();
  await running;

  // A 开了新回合；B 在钩子里等放行。C 这时拿到提交锁，但自己也停在自己的钩子里。
  await inputHeld("B");
  const sendingC = wrapper.send({ type: "follow_up", message: "C" });
  await tick();
  await tick();
  releaseInput("B");
  await inputHeld("C");

  // C 还没被 pi 接收：D 必须等这把锁，不能直通 pi 的队列。
  let dAcknowledged = false;
  const sendingD = wrapper.send({ type: "follow_up", message: "D" }).then((value) => {
    dAcknowledged = true;
    return value;
  });
  await tick();
  await tick();
  assert.equal(dAcknowledged, false, "D must wait for the submission holding the lock");

  releaseInput("C");
  await sendingC;
  await sendingD;
  await settle();
  assert.deepEqual(userTexts(), ["first", "A", "B", "C", "D"], "submissions keep their order");
});

test("a parked message whose skill file disappears does not block new submissions or follow-up commands", async (t) => {
  const gates = [];
  const startedArgs = [];
  const { wrapper, session, faux, events, userTexts, settle, skillFiles }
    = await commandSession(t, {
      skills: ["gone"],
      onCommand: async (args) => {
        startedArgs.push(args.trim());
        const gate = Promise.withResolvers();
        gates.push(gate);
        await gate.promise;
      },
    });
  assert.equal(skillFiles.length, 1);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("after answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const running = wrapper.send({ type: "prompt", message: "/slow first" });
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  // 引用了技能的消息被停在队列里；后面再排一条「后续」扩展命令；命令先结束，回合仍在跑。
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/skill:gone 看看" }), { queued: true });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow after-gone", streamingBehavior: "followUp" }), { queued: true });
  gates[0].resolve();
  await running;
  await tick();
  assert.equal(session.isStreaming, true);
  // 等待期间技能文件消失：队列检查不能再展开它（同步读文件会抛 ENOENT，拒绝无关的提交）。
  await rm(skillFiles[0].path);

  assert.deepEqual(await wrapper.send({ type: "prompt", message: "after" }), { queued: true });
  assert.deepEqual(
    (await wrapper.send({ type: "get_state" })).queuedMessages.steering.map((message) => message.text).length,
    2,
    "both steering submissions stay queued",
  );

  // 坏掉的技能消息标为仅移回后，排在它后面的「后续」命令必须按序先执行，不受它阻塞。
  for (let i = 0; i < 900 && gates.length < 2; i += 1) await tick();
  assert.deepEqual(startedArgs, ["first", "after-gone"]);
  assert.ok(events.some((event) => event.type === "prompt_error"), "the broken skill message reports instead of hanging");
  gates[1].resolve();

  // 命令结束后，排在它后面的无关消息 `after` 也照常发出。
  for (let i = 0; i < 900 && !userTexts().includes("after"); i += 1) await tick();
  assert.ok(userTexts().includes("after"), "the unrelated message still goes out");

  // 坏掉的那条留在队列里（可以「移回」），撤走之后会话空闲。
  assert.deepEqual((await wrapper.send({ type: "clear_queue" })).steering.map((message) => message.text), ["/skill:gone 看看"]);
  await settle();
});

test("a follow-up command behind a handled first prompt still dispatches once the session is idle", async (t) => {
  const gates = [];
  const startedArgs = [];
  const prepareGate = Promise.withResolvers();
  const { wrapper, userTexts, settle } = await commandSession(t, {
    handleInput: "swallowed first",
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
  });

  // 首条消息等待 prepare 期间，再发一条「后续」扩展命令排在它后面。
  wrapper.submitFirstPrompt({
    message: "swallowed first",
    prepare: () => prepareGate.promise,
  });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow after-first", streamingBehavior: "followUp" }), { queued: true });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "swallowed first", images: [] }],
    followUp: [{ text: "/slow after-first", images: [] }],
  });

  // 放行首条消息：扩展 input 钩子直接处理它（不开启回合），但后面的 `/slow after-first` 仍要继续派发。
  prepareGate.resolve();
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(userTexts(), []);
  assert.deepEqual(startedArgs, ["after-first"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow after-first"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });

  gates[0].resolve();
  await settle();
});

test("a follow-up command behind a failed first prompt still dispatches while keeping the failed prompt recallable", async (t) => {
  const gates = [];
  const startedArgs = [];
  const prepareGate = Promise.withResolvers();
  const { wrapper, events, settle } = await commandSession(t, {
    onCommand: async (args) => {
      startedArgs.push(args.trim());
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
    },
  });

  wrapper.submitFirstPrompt({
    message: "failed first",
    prepare: () => prepareGate.promise,
  });
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "/slow after-failed", streamingBehavior: "followUp" }), { queued: true });

  // 首条消息初始化失败：应保留在队列中供「移回」，同时放行排在它后面的 `/slow after-failed`。
  prepareGate.reject(new Error("prepare failed"));
  for (let i = 0; i < 300 && gates.length < 1; i += 1) await tick();
  assert.deepEqual(startedArgs, ["after-failed"]);
  assert.ok(events.some((event) => event.type === "prompt_error" && /prepare failed/.test(String(event.errorMessage))));
  assert.deepEqual((await wrapper.send({ type: "get_state" })).runningCommands, ["/slow after-failed"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "failed first", images: [] }],
    followUp: [],
  });

  gates[0].resolve();
  await settle();
  // 失败的首条消息仍可被「移回」，且不会被重新自动发送。
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), {
    steering: [{ text: "failed first", images: [] }],
    followUp: [],
  });
});

test("Stop hands back what waits behind a running command", async (t) => {
  const { wrapper, faux, events, userTexts, commandRuns, commandStarted, releaseCommand, settle } = await commandSession(t);

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "后续消息" }), { queued: true });

  // 内部中止（abortForUiFailure 带 keepQueue）拿不到返回值，不能替它清空：消息留在队列里。
  assert.deepEqual(await wrapper.send({ type: "abort", keepQueue: true }), {
    blockedByCommands: ["/slow"],
    steering: [],
    followUp: [],
  });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [{ text: "后续消息", images: [] }], followUp: [] });
  // 命令停不了，但说了「停」之后排队的消息不该再发出去：一起交还，由前端放回输入框。
  assert.deepEqual(await wrapper.send({ type: "abort" }), {
    blockedByCommands: ["/slow"],
    steering: [{ text: "后续消息", images: [] }],
    followUp: [],
  });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
  assert.ok(events.some((event) => event.type === "prompt_done" && event.aborted === true));

  faux.setResponses([fauxAssistantMessage([fauxText("never asked for")])]);
  releaseCommand();
  await command;
  await settle();
  assert.deepEqual(userTexts(), [], "the recalled message never reached a run");
  assert.equal(commandRuns(), 1);
});
test("an internal abort leaves what waits behind a command queued", async (t) => {
  const { wrapper, session, faux, userTexts, commandStarted, releaseCommand } = await commandSession(t);

  faux.setResponses([fauxAssistantMessage([fauxText("first reply ".repeat(30))])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const running = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "后续消息" }), { queued: true });

  // abortForUiFailure 的形态：带 keepQueue、返回值被丢弃，所以暂存消息必须留在队列里。
  await wrapper.send({ type: "abort", keepQueue: true });
  for (let i = 0; i < 300 && session.isStreaming; i += 1) await tick();
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [],
    followUp: [{ text: "后续消息", images: [] }],
  }, "an internal abort must not take the parked message away");
  // 排队等命令不是 Stop 停掉的工作：强制关闭解除，长时间的审查不会把只在内存里的消息关掉。
  assert.equal(wrapper.forceShutdownOnIdle, false, "a waiting message must not arm the forced cleanup");

  faux.setResponses([fauxAssistantMessage([fauxText("held answer")])]);
  releaseCommand();
  await running;
  for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
  assert.ok(userTexts().includes("后续消息"), "it still goes out once the command returns");
});

test("a failed delivery check leaves the queue row and the admission lock free", async (t) => {
  const { wrapper, faux, events, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t);

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "后续消息" }), { queued: true });

  // 会话文件读不出来（权限、I/O）：判断不了新旧就不能硬写，也不能把提交锁留在异常里。
  const inspector = wrapper.diskInspector;
  const inspect = inspector.inspect;
  inspector.inspect = () => { throw new Error("EACCES: permission denied"); };
  releaseCommand();
  await command;
  for (let i = 0; i < 300 && !events.some((event) => event.type === "prompt_error"); i += 1) await tick();
  assert.match(String(events.find((event) => event.type === "prompt_error")?.errorMessage), /读取会话文件失败/);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "后续消息", images: [] }],
    followUp: [],
  }, "the message stays a queue row");

  // 文件恢复可读后，提交必须还能被受理：锁没有跟着异常一起丢掉。
  inspector.inspect = inspect;
  faux.setResponses([
    fauxAssistantMessage([fauxText("after")]),
    fauxAssistantMessage([fauxText("held answer")]),
  ]);
  let admitted = false;
  const next = wrapper.send({ type: "prompt", message: "after" }).then((value) => { admitted = true; return value; });
  for (let i = 0; i < 100 && !admitted; i += 1) await tick();
  assert.equal(admitted, true, "the admission lock must not stay held after a failed check");
  await next;
  for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
  assert.deepEqual(userTexts(), ["after", "后续消息"]);
  await settle();
});
test("a persisted session still delivers what waited behind a command", async (t) => {
  const { wrapper, session, faux, events, userTexts, commandStarted, releaseCommand, settle } = await commandSession(t, { persisted: true });

  faux.setResponses([fauxAssistantMessage([fauxText("first reply")])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick();

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "后续消息" }), { queued: true });

  // 自己写过的文件不能误判成外部修改，消息照常派出。
  faux.setResponses([fauxAssistantMessage([fauxText("answered after the review")])]);
  releaseCommand();
  await command;
  for (let i = 0; i < 300 && !userTexts().includes("后续消息"); i += 1) await tick();
  assert.deepEqual(userTexts(), ["first", "后续消息"]);
  assert.deepEqual(events.filter((event) => event.type === "prompt_error"), []);
  await settle();
});
test("a message held behind a command is not written into an externally changed session", async (t) => {
  const { wrapper, session, faux, events, userTexts, commandStarted, releaseCommand } = await commandSession(t, { persisted: true });

  // 先落一条历史，会话文件存在之后才能被外部进程追加。
  faux.setResponses([fauxAssistantMessage([fauxText("first reply")])]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick();

  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "后续消息" }), { queued: true });

  // 消息在命令后等了好几分钟时，别的进程（pi TUI）追加了一条记录。
  appendFileSync(session.sessionFile, `${JSON.stringify({
    type: "custom", id: "external-entry", parentId: session.sessionManager.getLeafId(), timestamp: new Date().toISOString(), customType: "external", data: {},
  })}\n`);

  faux.setResponses([fauxAssistantMessage([fauxText("must not be asked")])]);
  releaseCommand();
  await command;
  for (let i = 0; i < 300 && !events.some((event) => event.type === "prompt_error"); i += 1) await tick();

  assert.ok(events.some((event) => event.type === "prompt_error"), "the user is told the message was not sent");
  assert.deepEqual(userTexts(), ["first"], "nothing was written onto the stale branch");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, {
    steering: [{ text: "后续消息", images: [] }],
    followUp: [],
  }, "it stays a queue row, so Recall can take it back");
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), { steering: [{ text: "后续消息", images: [] }], followUp: [] });
});

test("a follow-up still in preflight does not answer after Stop", async (t) => {
  const { wrapper, session, faux, events, userTexts, inputHeld, releaseInput, settle } =
    await commandSession(t, { holdInput: "A", submitGuard: true });
  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  // 提交先停在 pi 的 input 钩子里：它还没进任何队列，Stop 够不着它。
  const sending = wrapper.send({ type: "follow_up", message: "A" });
  await inputHeld("A");
  assert.equal(await wrapper.send({ type: "abort" }), null, "nothing was queued yet");
  const mark = events.length;
  releaseInput("A");

  // 钩子返回时回合已经停下：pi 会为它另起一轮，wrapper 认出这条提交并立刻停掉它。
  await assert.rejects(sending, /会话已停止/);
  await settle();
  assert.deepEqual(
    events.slice(mark).filter((event) => event.type === "message_update"),
    [],
    "the stopped submission must not produce an answer",
  );
  assert.equal(userTexts().includes("A"), false, "the stopped submission never entered the transcript");
  assert.equal(wrapper.isRunning(), false);
});

test("a parked follow-up stopped inside its input hook stays a queue row", async (t) => {
  const { wrapper, session, faux, events, userTexts, commandStarted, releaseCommand, inputHeld, releaseInput } =
    await commandSession(t, { holdInput: "B", submitGuard: true });
  faux.setResponses([fauxAssistantMessage([fauxText("B answered")])]);

  // `/review` 形态：命令跑着，消息先排进暂存队列，不在 pi 的队列里。
  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;
  assert.deepEqual(await wrapper.send({ type: "follow_up", message: "B" }), { queued: true });

  // 命令返回后这条消息出队派发，卡在 input 钩子里：此刻它不在任何队列，Stop 只够得着守卫。
  releaseCommand();
  await inputHeld("B");
  const mark = events.length;
  await wrapper.send({ type: "abort" });
  releaseInput("B");
  // 钩子放行后 pi 才回调预检，重新入队是异步的。
  for (let i = 0; i < 300 && wrapper.mergedQueuedMessages().followUp.length === 0; i += 1) await tick();

  assert.equal(userTexts().includes("B"), false, "the stopped message never entered the transcript");
  assert.deepEqual(
    wrapper.mergedQueuedMessages().followUp.map((entry) => entry.text),
    ["B"],
    "it comes back as a queue row for Recall",
  );
  assert.deepEqual(
    events.slice(mark).filter((event) => event.type === "message_update"),
    [],
    "no turn runs for it",
  );
  assert.equal(session.isIdle, true, "pi never started a run");
  assert.equal(wrapper.isRunning(), false, "a recall-only row is not running work");
  assert.equal(wrapper.isIdleEvictable(), false, "but the session stays alive to keep it");

  // 下一轮正常回复结束后 flush 会再跑一遍，但这一行只等「移回」，不能被自动发出去。
  faux.setResponses([fauxAssistantMessage([fauxText("after reply")])]);
  await wrapper.send({ type: "prompt", message: "after" });
  for (let i = 0; i < 900 && (session.isStreaming || !session.isIdle); i += 1) await tick();
  assert.equal(userTexts().includes("B"), false, "the next settle must not deliver it");
  assert.deepEqual(
    wrapper.mergedQueuedMessages().followUp.map((entry) => entry.text),
    ["B"],
    "it is still a queue row, waiting for Recall",
  );
  await command;
  await wrapper.send({ type: "clear_queue" });
});

test("Stop while an extension command runs voids a submission waiting for the lock", async (t) => {
  const { wrapper, commandStarted, releaseCommand, settle } = await commandSession(t, { submitGuard: true });
  const command = wrapper.send({ type: "prompt", message: "/slow" });
  await commandStarted;

  // 生产里占着提交锁的是正在等 MCP 连接的那条提交；这里由测试直接占住。Stop 走「命令停不了」
  // 的分支，它必须同时作废还在等锁的提交，否则命令结束后这条会被自动发出去。
  const releaseHold = await wrapper.acquirePromptAdmission();
  const waiting = wrapper.send({ type: "follow_up", message: "B" });
  await tick();

  const stopped = await wrapper.send({ type: "abort" });
  assert.deepEqual(stopped?.blockedByCommands, ["/slow"], "the command itself keeps running");
  releaseHold();

  await assert.rejects(waiting, /会话已停止/);
  releaseCommand();
  await command;
  await settle();
});

test("a submission waiting for the lock is voided by a Stop", async (t) => {
  const { wrapper, session, faux, userTexts, inputHeld, releaseInput } =
    await commandSession(t, { holdInput: "A", submitGuard: true });
  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  // A 占着提交锁（卡在 input 钩子里），B 只能排队等锁——此刻 B 还没读到任何代次。
  const first = wrapper.send({ type: "follow_up", message: "A" });
  await inputHeld("A");
  const second = wrapper.send({ type: "follow_up", message: "B" });
  await tick();
  assert.equal(await wrapper.send({ type: "abort" }), null);
  releaseInput("A");

  await assert.rejects(first, /会话已停止/);
  await assert.rejects(second, /会话已停止/, "a submission that waited through the Stop is not sent");
  assert.equal(userTexts().includes("B"), false);
});

test("an input hook that rewrites the text cannot revive a stopped submission", async (t) => {
  const { wrapper, session, faux, events, userTexts, inputHeld, releaseInput, settle } = await commandSession(t, {
    holdInput: "A",
    transformInput: { from: "A", to: "A, rewritten by the hook" },
    submitGuard: true,
  });
  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(30))]),
    fauxAssistantMessage([fauxText("A answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();

  const sending = wrapper.send({ type: "follow_up", message: "A" });
  await inputHeld("A");
  await wrapper.send({ type: "abort" });
  const mark = events.length;
  releaseInput("A");

  await assert.rejects(sending, /会话已停止/);
  await settle();
  assert.equal(userTexts().some((text) => text.includes("A")), false, "nothing of it was written");
  assert.deepEqual(
    events.slice(mark).filter((event) => event.type === "message_update"),
    [],
    "no turn ran for it",
  );
});

test("a follow-up and a prompt submitted together wait once for startup", async (t) => {
  const { wrapper, session, faux, settle } = await commandSession(t);
  const counts = { waits: 0, admissions: 0 };
  const waitForExtensionsBound = wrapper.waitForExtensionsBound.bind(wrapper);
  wrapper.waitForExtensionsBound = async () => {
    counts.waits += 1;
    return waitForExtensionsBound();
  };
  const acquirePromptAdmission = wrapper.acquirePromptAdmission.bind(wrapper);
  wrapper.acquirePromptAdmission = () => {
    counts.admissions += 1;
    return acquirePromptAdmission();
  };
  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply ".repeat(40))]),
    fauxAssistantMessage([fauxText("answered")]),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  for (let i = 0; i < 300 && !session.isStreaming; i += 1) await tick();
  counts.waits = 0;
  counts.admissions = 0;

  const followUp = wrapper.send({ type: "follow_up", message: "A" });
  const prompt = wrapper.send({ type: "prompt", message: "B" });
  await Promise.all([followUp, prompt]);

  // `follow_up` 曾递归调用 `send()`，于是同一条提交多等一次扩展绑定；后到的普通提示只等一次，
  // 反而先拿到提交锁。归一之后两条提交各等一次、共用一个排锁入口。
  assert.equal(counts.waits, 2, "each submission waits for startup exactly once");
  assert.equal(counts.admissions, 2, "both submissions share the one admission lock");
  assert.deepEqual(
    wrapper.mergedQueuedMessages().followUp.map((entry) => entry.text),
    ["A", "B"],
    "the earlier submission queues first",
  );
  await settle();
});
