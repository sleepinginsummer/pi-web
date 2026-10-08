import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

function makeModelRuntime() {
  const model = { provider: "test-provider", id: "test-model", api: "openai-completions" };
  return { model, modelRuntime: { getModel: () => model }, setModel: async () => {} };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makePromptInner(prompt) {
  return {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    ...makeModelRuntime(),
    extensionRunner: { getRegisteredCommands: () => [] },
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    systemPrompt: "",
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt,
    dispose() {},
  };
}

test("get_state waits for extension resources before returning the system prompt", async (t) => {
  let finishBinding;
  const inner = makePromptInner(() => Promise.resolve());
  inner.systemPrompt = "before extensions";
  inner.bindExtensions = () => new Promise((resolve) => {
    finishBinding = () => {
      // Binding extensions can rewrite the prompt, so get_state must read it afterwards.
      inner.systemPrompt = "after extensions";
      resolve();
    };
  });

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();

  let settled = false;
  const statePromise = wrapper.send({ type: "get_state" }).then((state) => {
    settled = true;
    return state;
  });
  await nextTurn();

  assert.equal(settled, false);
  finishBinding();
  const state = await statePromise;

  assert.equal(state.systemPrompt, "after extensions");
});

test("get_state reports the prompt of a session that has not run anything yet", async (t) => {
  // Pi 0.86 replays agent.state.systemPrompt from the transcript, so it is empty until the
  // first run persists a system message. Reporting that empty string made the System panel
  // claim "the prompt is empty (tools are disabled)" on every brand-new session.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "",
    enumerable: true,
  });
  inner.systemPrompt = "Pi rendered prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "Pi rendered prompt");
});

test("get_state keeps reporting the replayed prompt once the transcript has one", async (t) => {
  // After a run the session getter falls back to the base options, which no longer carry the
  // sections a before_agent_start handler changed for that run; the transcript still does.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "base prompt\n\nextension section",
    enumerable: true,
  });
  inner.systemPrompt = "base prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "base prompt\n\nextension section");
});

test("prompt commands wait for SDK preflight acceptance before acknowledging", async (t) => {
  let acceptPreflight;
  let finishPrompt;
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    acceptPreflight = () => options.preflightResult("started");
    finishPrompt = resolve;
  }));
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  let acknowledged = false;
  const sending = wrapper.send({ type: "prompt", message: "hello" }).then(() => {
    acknowledged = true;
  });
  await nextTurn();

  assert.equal(acknowledged, false);
  assert.equal(wrapper.isRunning(), true);

  acceptPreflight();
  await sending;

  assert.equal(acknowledged, true);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(events.some((event) => event.type === "prompt_done"), false);

  finishPrompt();
  await nextTurn();

  assert.equal(wrapper.isRunning(), false);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
});

test("prompt_done 仅在已接受的 prompt 完成后广播", async (t) => {
  let finishPrompt;
  let sdkListener;
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    inner.isStreaming = true;
    options.preflightResult("started");
    finishPrompt = () => { inner.isStreaming = false; resolve(); };
  }));
  inner.subscribe = (listener) => { sdkListener = listener; return () => {}; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "hello" });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.equal(events.filter((type) => type === "prompt_done").length, 0);

  finishPrompt();
  await nextTurn();
  assert.equal(events.filter((type) => type === "prompt_done").length, 1);
});

test("扩展注入的运行通过 agent_settled 向 SSE 客户端收尾", (t) => {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => { sdkListener = listener; return () => {}; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));
  wrapper.start();

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  assert.equal(wrapper.isRunning(), true);
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, ["agent_start", "agent_end", "agent_settled"]);
});

test("new event listeners receive the latest active tool update", (t) => {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();

  sdkListener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });
  sdkListener({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one" }] } });
  const latest = { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one\ntwo" }] } };
  sdkListener(latest);

  const replayed = [];
  const unsubscribe = wrapper.onEvent((event) => replayed.push(event));
  assert.deepEqual(replayed, [latest]);

  unsubscribe();
  sdkListener({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash" });
  const afterEnd = [];
  wrapper.onEvent((event) => afterEnd.push(event));
  assert.deepEqual(afterEnd, []);
});

function startToolEventWrapper(t) {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  const replay = () => {
    const replayed = [];
    wrapper.onEvent((event) => replayed.push(event))();
    return replayed;
  };
  return { emit: (event) => sdkListener(event), replay };
}

test("does not replay the nested calls of a running codemode script", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const parentStart = { type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: { code: "" } };
  emit(parentStart);
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {}, parentToolCallId: "call-1" });
  emit({ type: "tool_execution_update", toolCallId: "call-1/1", toolName: "read", args: {}, partialResult: {}, parentToolCallId: "call-1" });
  const snapshot = {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "codemode",
    partialResult: { content: [], details: { calls: [{ id: "call-1/?", name: "read", status: "running" }] } },
  };
  emit(snapshot);
  emit({ type: "tool_execution_start", toolCallId: "call-1/2", toolName: "read", args: {}, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [snapshot]);
});

test("a tool call's end also forgets calls recorded under its id", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  // A nested call that reached the wrapper without its parent id.
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "call-1/1/1", toolName: "read", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });

  assert.deepEqual(replay(), [other]);
});

test("tolerates a nested end after its parent ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });
  emit({ type: "tool_execution_end", toolCallId: "call-1/1", toolName: "read", isError: true, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [other]);
});

test("replays no tool call once the run has ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: {} });
  emit({ type: "agent_end", messages: [] });

  assert.deepEqual(replay(), []);
});

test("suppressed sessions do not emit completion notifications", (t) => {
  let sdkListener;
  const completed = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner, new Set(), "test", {
    onAgentRunComplete: (sessionId) => completed.push(sessionId),
    suppressCompletionNotifications: true,
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.deepEqual(completed, []);
});

test("prompt commands reject when SDK preflight fails", async (t) => {
  const inner = makePromptInner(() => Promise.reject(new Error("Authentication failed")));
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello" }),
    /Authentication failed/,
  );

  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, []);
});

test("accepted prompt failures still finish through the event stream", async (t) => {
  let failPrompt;
  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return new Promise((_resolve, reject) => {
      failPrompt = () => reject(new Error("post-accept failure"));
    });
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({ type: "prompt", message: "hello" });
  failPrompt();
  await nextTurn();

  assert.deepEqual(events.map((event) => event.type), ["prompt_error", "prompt_done"]);
});

test("queued prompt commands forward their streaming behavior and acknowledge acceptance", async (t) => {
  let receivedOptions;
  const inner = makePromptInner((_message, options) => {
    receivedOptions = options;
    options.preflightResult("queued");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({
    type: "prompt",
    message: "next",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(receivedOptions.streamingBehavior, "followUp");
  assert.equal(receivedOptions.source, "rpc");
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, []);
});

test("an exact system prompt is reported by get_state without touching the SDK prompt state", async (t) => {
  // Since Pi 0.86 the SDK prompt state is a getter replayed from the transcript.
  // The exact prompt reaches the model through before_agent_start instead, so
  // the wrapper must never assign it, even around prompt preflight.
  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return Promise.resolve();
  });
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "Pi structured sections",
    enumerable: true,
  });
  const wrapper = new AgentSessionWrapper(inner, new Set(), "test", {
    exactSystemPrompt: () => "context prompt",
    chatOnly: true,
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "context prompt");
  assert.equal(inner.agent.state.systemPrompt, "Pi structured sections");
  assert.equal(inner.agent.prepareNextTurnWithContext, undefined);
});

test("prompt admission waits for the preceding preflight and keeps overlapping runs counted", async (t) => {
  let callCount = 0;
  let acceptFirst;
  let finishFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        acceptFirst = () => {
          inner.isStreaming = true;
          options.preflightResult("started");
        };
        finishFirst = () => {
          inner.isStreaming = false;
          resolve();
        };
      });
    }

    assert.equal(inner.isStreaming, true);
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const first = wrapper.send({ type: "prompt", message: "first" });
  await nextTurn();
  const queued = wrapper.send({
    type: "prompt",
    message: "queued",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(callCount, 1);
  acceptFirst();
  await Promise.all([first, queued]);
  await nextTurn();

  assert.equal(callCount, 2);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, true);

  finishFirst();
  await nextTurn();

  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
});

test("prompt admission continues after the preceding preflight rejects", async (t) => {
  let callCount = 0;
  let rejectFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = () => reject(new Error("first rejected"));
      });
    }
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const firstRejected = assert.rejects(
    wrapper.send({ type: "prompt", message: "first" }),
    /first rejected/,
  );
  await nextTurn();
  const second = wrapper.send({ type: "prompt", message: "second" });
  await nextTurn();
  assert.equal(callCount, 1);

  rejectFirst();
  await Promise.all([firstRejected, second]);

  assert.equal(callCount, 2);
  assert.equal(wrapper.isRunning(), false);
});

test("a failing event listener cannot reject prompt completion", async (t) => {
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
  });
  console.error = () => {};

  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const delivered = [];
  wrapper.onEvent(() => {
    throw new Error("listener failed");
  });
  wrapper.onEvent((event) => delivered.push(event.type));

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  assert.deepEqual(delivered, ["prompt_done"]);
  assert.equal(wrapper.isRunning(), false);
});

test("session shutdown notifies extensions before disposing the SDK session", async () => {
  const calls = [];
  const inner = {
    ...makeModelRuntime(),
    isBashRunning: false,
    sessionManager: { getEntries: () => [] },
    extensionRunner: {
      getRegisteredCommands: () => [],
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["destroy"]));

  await Promise.all([wrapper.shutdown(), wrapper.shutdown()]);

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("session shutdown still disposes the SDK session when an extension fails", async () => {
  const calls = [];
  const inner = {
    ...makeModelRuntime(),
    isBashRunning: false,
    sessionManager: { getEntries: () => [] },
    extensionRunner: {
      getRegisteredCommands: () => [],
      async emit() {
        calls.push("emit");
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  await assert.rejects(wrapper.shutdown(), /shutdown hook failed/);

  assert.deepEqual(calls, ["emit", "dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("destroy notifies event listeners so attached SSE streams can close", () => {
  const inner = {
    isBashRunning: false,
    ...makeModelRuntime(),
    sessionManager: { getEntries: () => [] },
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));
  wrapper.destroy();
  assert.deepEqual(events, ["session_shutdown"]);
});

test("a listener that unsubscribes while handling an event does not hide it from the next one", () => {
  const inner = {
    isBashRunning: false,
    ...makeModelRuntime(),
    sessionManager: { getEntries: () => [] },
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const received = [];
  const stopFirst = wrapper.onEvent((event) => {
    received.push(["first", event.type]);
    stopFirst();
  });
  wrapper.onEvent((event) => received.push(["second", event.type]));
  wrapper.onEvent((event) => received.push(["third", event.type]));

  wrapper.destroy();

  assert.deepEqual(received, [
    ["first", "session_shutdown"],
    ["second", "session_shutdown"],
    ["third", "session_shutdown"],
  ]);
});

test("direct destruction disposes the SDK session before unregistering the wrapper", () => {
  const calls = [];
  const inner = {
    ...makeModelRuntime(),
    isBashRunning: false,
    sessionManager: { getEntries: () => [] },
    extensionRunner: { getRegisteredCommands: () => [] },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  wrapper.destroy();
  wrapper.destroy();

  assert.deepEqual(calls, ["dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("idle timer preserves extension-owned session work until it becomes inactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let active = true;
  const inner = {
    ...makeModelRuntime(),
    sessionId: "session-1",
    sessionFile: "",
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    extensionRunner: {
      getRegisteredCommands: () => [],
      async emit(event) { calls.push(["emit", event]); },
    },
    agent: { state: {} },
    subscribe: () => () => {},
    dispose: () => calls.push(["dispose"]),
  };
  const release = registerSessionLivenessProvider({
    name: "test-extension",
    sessionId: "session-1",
    isActive: () => active,
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(release);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(calls, []);

  active = false;
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
  ]);
});

test("首条用户消息对外广播前创建新会话文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-session-"));
  const manager = SessionManager.create(directory, directory);
  const sessionFile = manager.getSessionFile();
  let sdkListener;
  let fileExistedWhenForwarded = false;
  const inner = {
    ...makeModelRuntime(),
    sessionId: manager.getSessionId(),
    sessionFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { getRegisteredCommands: () => [] },
    subscribe(listener) {
      sdkListener = listener;
      return () => {};
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    wrapper.onEvent((event) => {
      if (event.type === "message_end") fileExistedWhenForwarded = existsSync(sessionFile);
    });
    wrapper.start();

    const message = { role: "user", content: "hello", timestamp: Date.now() };
    sdkListener({ type: "message_end", message });
    // SDK 在 listener 返回后才执行内部的 appendMessage。
    manager.appendMessage(message);

    const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(fileExistedWhenForwarded, true);
    assert.equal(lines[0].type, "session");
    assert.equal(lines[1].message.content, "hello");
  } finally {
    wrapper.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
