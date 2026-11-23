import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { resolveSessionIdleTimeoutMs } = await jiti.import("./rpc-manager.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makeIdleInner() {
  const model = {
    provider: "test-provider",
    id: "test-model",
    api: "openai-completions",
  };
  return {
    sessionId: "session-1",
    sessionManager: {
      getEntries: () => [],
      appendCustomEntry: () => "entry-1",
      getEntry: () => undefined,
      getSessionFile: () => undefined,
    },
    modelRuntime: {
      getModel: () => model,
    },
    model,
    setModel: async () => {},
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {
      getRegisteredCommands: () => [],
    },
    // 排队事件会读这两条真实队列；没有它们时 emitQueueUpdate 会报结构不兼容。
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    subscribe: () => () => {},
    dispose() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
  };
}

test("defaults to the 10-minute idle timeout when the env var is unset or blank", () => {
  assert.equal(resolveSessionIdleTimeoutMs(), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs(""), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("   "), 10 * 60 * 1000);
});

test("treats zero as disabling idle shutdown", () => {
  assert.equal(resolveSessionIdleTimeoutMs("0"), 0);
});

test("uses a positive value as the timeout in milliseconds", () => {
  assert.equal(resolveSessionIdleTimeoutMs("1800000"), 1_800_000);
  assert.equal(resolveSessionIdleTimeoutMs("2147483647"), 2_147_483_647);
});

test("falls back to the 10-minute default and warns for invalid or out-of-range values", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(resolveSessionIdleTimeoutMs("abc"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("-5"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("NaN"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("Infinity"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("2147483648"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("2592000000"), 10 * 60 * 1000);
  assert.equal(warn.mock.callCount(), 6);
});

async function withIdleTimeoutEnv(rawValue, run) {
  const previousValue = process.env.PI_WEB_IDLE_TIMEOUT_MS;
  process.env.PI_WEB_IDLE_TIMEOUT_MS = rawValue;
  try {
    const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const { AgentSessionWrapper } = await freshJiti.import("./rpc-manager.ts");
    await run(AgentSessionWrapper);
  } finally {
    if (previousValue === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
    else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousValue;
  }
}

test("PI_WEB_IDLE_TIMEOUT_MS=0 still reaps a run that Stop cannot unwind", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    // A handler that ignores the abort signal keeps the SDK run pending forever.
    inner.abort = () => new Promise(() => {});
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    t.mock.timers.tick(60 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    void wrapper.send({ type: "abort" });
    await nextTurn();
    t.mock.timers.tick(10 * 60 * 1000 - 1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
});

test("PI_WEB_IDLE_TIMEOUT_MS=0 keeps a session alive after Stop unwinds its run", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    inner.abort = async () => {
      inner.isStreaming = false;
    };
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    await wrapper.send({ type: "abort" });
    t.mock.timers.tick(60 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
  });
});

test("a message queued behind a running command does not arm Stop's forced cleanup", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    inner.abort = async () => {
      inner.isStreaming = false;
    };
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    // 回合 + 扩展命令并行：一条消息排在命令后面，命令和它各占一个 pendingPrompts token。
    const commandToken = wrapper.pendingPrompts.begin();
    wrapper.runningCommands.push("/review");
    const parkedToken = wrapper.pendingPrompts.begin();
    // 与真实停放一致：令牌挂在条目上，由 parkDuringCompaction 登记。
    wrapper.parkDuringCompaction({
      message: "kept",
      command: false,
      delivering: false,
      token: parkedToken,
      settle: () => wrapper.pendingPrompts.finish(parkedToken),
    });

    await wrapper.send({ type: "abort", keepQueue: true });
    assert.equal(wrapper.forceShutdownOnIdle, false, "waiting on a command is not work Stop stopped");
    t.mock.timers.tick(60 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true, "the queued message must survive a long review");

    wrapper.pendingPrompts.finish(commandToken);
    wrapper.runningCommands.length = 0;
  });
});

test("a settled queue row does not offset a submission stuck in preflight", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    // Stop 收不回来的中止：强制关闭的期限才是兜底。
    inner.abort = () => new Promise(() => {});
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    // 派发失败后重新入队的旧行：令牌早已交还，只剩一条队列行。
    wrapper.parkedDuringCompaction.push({ message: "stale", delivering: false, settle: () => {} });
    // 一条真正卡在 SDK 预检里的提交：占着令牌，还没进入流式状态。
    wrapper.pendingPrompts.begin();

    void wrapper.send({ type: "abort", keepQueue: true });
    await nextTurn();
    assert.equal(wrapper.forceShutdownOnIdle, true, "a submission still in preflight keeps the deadline armed");
    t.mock.timers.tick(10 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false, "the stuck submission is still reaped");
  });
});

test("a message that left the queue is real work again for Stop's forced deadline", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    // Stop 收不回来的中止：强制关闭的期限才是兜底。
    inner.abort = () => new Promise(() => {});
    // 派发卡在 pi 预检里：`prompt` 一直不返回，preflightResult 也不来。
    inner.prompt = () => new Promise(() => {});
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    const dispatchingToken = wrapper.pendingPrompts.begin();
    wrapper.parkDuringCompaction({
      message: "dispatching",
      command: false,
      token: dispatchingToken,
      settle: () => wrapper.pendingPrompts.finish(dispatchingToken),
    });
    void wrapper.flushParkedPrompts();
    for (let i = 0; i < 5; i += 1) await nextTurn();
    assert.equal(wrapper.parkedDuringCompaction.length, 0, "the row left the queue");
    assert.equal(wrapper.parkedPromptTokens.size, 0, "a dispatching row is no longer waiting");

    // 另一条仍在等待派发的队列行：它才该被扣掉。
    const waitingToken = wrapper.pendingPrompts.begin();
    wrapper.parkDuringCompaction({
      message: "kept",
      command: false,
      token: waitingToken,
      settle: () => wrapper.pendingPrompts.finish(waitingToken),
    });

    void wrapper.send({ type: "abort", keepQueue: true });
    await nextTurn();
    // size(2) > 排队中的令牌(1)：卡在预检的那条仍算被停掉的工作。
    assert.equal(wrapper.forceShutdownOnIdle, true, "a message stuck in preflight is reaped, not offset by the queue");
  });
});

test("a settled queue row cannot restore its old token when re-parked", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    const token = wrapper.pendingPrompts.begin();
    const entry = {
      message: "failed",
      command: false,
      token,
      settle: () => wrapper.pendingPrompts.finish(token),
    };
    wrapper.parkDuringCompaction(entry);
    assert.equal(wrapper.parkedPromptTokens.size, 1);

    // 派发失败后重新入队：先结算，再由派发路径重新停放（同一个条目）。
    wrapper.settleParked(entry);
    wrapper.parkDuringCompaction(entry);
    assert.equal(entry.token, undefined, "a settled row holds no token any more");
    assert.equal(wrapper.parkedPromptTokens.size, 0, "it must not offset work that is still running");
  });
});

for (const rawValue of ["", "0"]) {
  test(`PI_WEB_IDLE_TIMEOUT_MS=${JSON.stringify(rawValue)}: pressing Stop again does not postpone the forced cleanup`, async (t) => {
    await withIdleTimeoutEnv(rawValue, async (AgentSessionWrapper) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const inner = makeIdleInner();
      inner.isStreaming = true;
      inner.abort = () => new Promise(() => {});
      const wrapper = new AgentSessionWrapper(inner);
      t.after(() => wrapper.destroy());
      wrapper.start();

      void wrapper.send({ type: "abort" });
      await nextTurn();
      t.mock.timers.tick(9 * 60 * 1000);
      await nextTurn();
      // A stuck user presses Stop again (or reloads the page).
      void wrapper.send({ type: "abort" });
      await nextTurn();
      assert.equal(wrapper.isAlive(), true);

      t.mock.timers.tick(60 * 1000);
      await nextTurn();
      assert.equal(wrapper.isAlive(), false);
    });
  });
}

test("PI_WEB_IDLE_TIMEOUT_MS=0 reaps a bash command that abort_bash cannot stop", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isBashRunning = true;
    inner.abortBash = () => {};
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    await wrapper.send({ type: "abort_bash" });
    t.mock.timers.tick(10 * 60 * 1000 - 1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
});

for (const [rawValue, timeoutMs] of [
  ["0", 0],
  ["1800000", 1_800_000],
  ["2592000000", 600_000],
]) {
  test(`PI_WEB_IDLE_TIMEOUT_MS=${rawValue} applies to an idle session`, async (t) => {
    const previousValue = process.env.PI_WEB_IDLE_TIMEOUT_MS;
    process.env.PI_WEB_IDLE_TIMEOUT_MS = rawValue;
    try {
      const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
      const { AgentSessionWrapper } = await freshJiti.import("./rpc-manager.ts");

      t.mock.timers.enable({ apis: ["setTimeout"] });
      const wrapper = new AgentSessionWrapper(makeIdleInner());
      t.after(() => wrapper.destroy());
      wrapper.start();
      assert.equal(wrapper.isRunning(), false);

      t.mock.timers.tick(timeoutMs === 0 ? 60 * 60 * 1000 : timeoutMs - 1);
      await nextTurn();
      assert.equal(wrapper.isAlive(), true);

      if (timeoutMs !== 0) {
        t.mock.timers.tick(1);
        await nextTurn();
        assert.equal(wrapper.isAlive(), false);
      }
    } finally {
      if (previousValue === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
      else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousValue;
    }
  });
}

// A page's lease renewal (POST /api/agent/[id]/lease) is the session's one countdown.
test("renewIdleTimer() starts the idle countdown over, and is not a command", async (t) => {
  await withIdleTimeoutEnv("", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const wrapper = new AgentSessionWrapper(makeIdleInner());
    t.after(() => wrapper.destroy());
    wrapper.start();
    const before = wrapper.getDebugSnapshot();

    t.mock.timers.tick(9 * 60 * 1000);
    wrapper.renewIdleTimer();
    const after = wrapper.getDebugSnapshot();
    assert.deepEqual(after.idle, { ...before.idle, lastResetAt: 1_540_000, nextCheckAt: 1_540_000 + 10 * 60 * 1000 });
    assert.equal(after.lastCommand, null);
    assert.equal(after.run.mutatingCommands, before.run.mutatingCommands);

    // A closed tab: reaped one idle timeout after its last renewal, not before.
    t.mock.timers.tick(10 * 60 * 1000 - 1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
});

test("renewIdleTimer() never moves Stop's forced deadline", async (t) => {
  await withIdleTimeoutEnv("", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    inner.abort = () => new Promise(() => {});
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    void wrapper.send({ type: "abort" });
    await nextTurn();
    const forced = wrapper.getDebugSnapshot().idle;
    assert.equal(forced.forcedByStop, true);
    t.mock.timers.tick(9 * 60 * 1000);
    wrapper.renewIdleTimer();
    assert.deepEqual(wrapper.getDebugSnapshot().idle, forced);

    t.mock.timers.tick(60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
});

test("renewIdleTimer() arms nothing on a closing or destroyed wrapper", async (t) => {
  await withIdleTimeoutEnv("", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    // session_shutdown never settles: the wrapper stays closing until the shutdown deadline.
    inner.extensionRunner = { emit: () => new Promise(() => {}) };
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();
    const armed = wrapper.getDebugSnapshot().idle;

    const closing = wrapper.shutdown();
    await nextTurn();
    assert.equal(wrapper.getDebugSnapshot().state, "closing");
    t.mock.timers.tick(1_000);
    wrapper.renewIdleTimer();
    assert.deepEqual(wrapper.getDebugSnapshot().idle, armed, "a closing wrapper is not revived");

    t.mock.timers.tick(60 * 1000);
    await closing;
    wrapper.renewIdleTimer();
    assert.equal(wrapper.getDebugSnapshot().idle.nextCheckAt, null);
    assert.equal(wrapper.isAlive(), false);
  });
});

test("renewIdleTimer() keeps idle reaping disabled under PI_WEB_IDLE_TIMEOUT_MS=0", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wrapper = new AgentSessionWrapper(makeIdleInner());
    t.after(() => wrapper.destroy());
    wrapper.start();
    wrapper.renewIdleTimer();
    assert.equal(wrapper.getDebugSnapshot().idle.nextCheckAt, null);
    t.mock.timers.tick(60 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
  });
});
