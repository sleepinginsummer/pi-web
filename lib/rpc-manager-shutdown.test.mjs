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
