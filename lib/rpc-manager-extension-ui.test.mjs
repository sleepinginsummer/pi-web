import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, handler = async () => {}, overrides = {}) {
  let ui;
  const errors = [];
  const inner = {
    sessionId: "extension-ui-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => "/tmp" },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    agent: { state: {}, abort() {} },
    abortBranchSummary() {}, abortCompaction() {}, abortRetry() {}, dispose() {},
    // Use the SDK's actual command dispatch and idle-agent abort paths.
    prompt: AgentSession.prototype.prompt,
    _tryExecuteExtensionCommand: AgentSession.prototype._tryExecuteExtensionCommand,
    abort: AgentSession.prototype.abort,
    waitForIdle: AgentSession.prototype.waitForIdle,
    _extensionRunner: {
      getCommand: () => ({ handler: () => handler(ui) }),
      createCommandContext: () => ({}),
      emitError: (error) => errors.push(error),
    },
    extensionRunner: {},
    ...overrides,
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  ui = wrapper.createExtensionUiContext();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, ui, events, errors, inner };
}

test("初始化审批在绑定完成前通过 SSE 可见；拒绝后完成绑定并允许切换模型", async (t) => {
  const models = [
    { provider: "test", id: "model-a", api: "openai-completions" },
    { provider: "test", id: "model-b", api: "openai-completions" },
  ];
  let approved;
  const { wrapper, events, inner } = setup(t, undefined, {
    model: models[0],
    modelRuntime: { getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    extensionRunner: { getRegisteredCommands: () => [] },
    getContextUsage: () => null,
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    bindExtensions: async ({ uiContext }) => {
      approved = await uiContext.confirm("Allow project MCP server “godot-ai”?", "Run local command?");
    },
  });
  inner.setModel = async (model) => { inner.model = model; };
  wrapper.beginExtensionBinding();
  // 第二阶段不再等绑定完成：状态立刻返回，并如实标注扩展仍在初始化。
  const initialState = await wrapper.send({ type: "get_state" });
  assert.equal(initialState.model.id, "model-a");
  assert.equal(initialState.extensionsInitializing, true);
  const stream = createAgentEventStream(
    new Request("http://localhost/api/agent/extension-ui-test/events"),
    wrapper.sessionId,
    Promise.resolve(wrapper),
  );
  const reader = stream.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let request;
  while (!request) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      if (event.method === "confirm") request = event;
    }
  }
  assert.equal(wrapper.extensionsInitializing, true, "审批必须在绑定完成之前可见");
  await wrapper.send({ type: "extension_ui_response", id: request.id, confirmed: false });
  await nextTurn();
  assert.equal(wrapper.extensionsInitializing, false, "拒绝审批后绑定应完成");
  assert.ok(events.some((event) => event.type === "extensions_bound"));
  assert.equal(approved, false, "不得自动批准 MCP");
  assert.deepEqual(await wrapper.send({ type: "set_model", provider: "test", modelId: "model-b" }), {
    id: "model-b", provider: "test",
  });
  assert.equal((await wrapper.send({ type: "get_state" })).model.id, "model-b");
});

for (const method of ["select", "confirm", "input", "editor", "custom"]) {
  test(`Stop unwinds a command waiting on ${method} and closes its UI`, async (t) => {
    let continued = false;
    let disposed = 0;
    const { wrapper, events, errors } = setup(t, async (ui) => {
      if (method === "custom") {
        await ui.custom(() => ({ render: () => ["Choose"], dispose: () => { disposed += 1; } }));
      } else {
        await ui[method]("Choose", method === "select" ? ["A", "B"] : "Details");
      }
      continued = true;
    });
    const sending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const request = events.find((event) => event.method === method);
    assert.ok(request);
    assert.equal(wrapper.isRunning(), true);

    await wrapper.send({ type: "abort" });
    await sending;
    await nextTurn();
    assert.equal(continued, false);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.pendingUiResponses.size, 0);
    assert.equal(wrapper.activeCustomUis.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /cancelled by Stop/);
    assert.ok(events.some((event) => event.id === request.id && (event.type === "extension_ui_closed" || event.closed)));
    assert.ok(events.some((event) => event.type === "prompt_done"));
    assert.equal(disposed, method === "custom" ? 1 : 0);
    const replay = [];
    wrapper.onEvent((event) => replay.push(event))();
    assert.equal(replay.some((event) => event.id === request.id), false);

    // A later explicit command can ask again; answering still resumes it.
    const nextSending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const nextRequest = events.findLast((event) => event.method === method && !event.closed);
    assert.notEqual(nextRequest.id, request.id);
    if (method === "custom") wrapper.closeCustomUi(nextRequest.id, "A");
    else await wrapper.send({ type: "extension_ui_response", id: nextRequest.id, value: "A", confirmed: true });
    await nextSending;
    assert.equal(continued, true);
  });
}

test("normal cancel and caller abort keep UI defaults and notify all subscribers", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  await wrapper.send({ type: "extension_ui_response", id: request.id, cancelled: true });
  assert.equal(await pending, undefined);
  assert.deepEqual(events.at(-1), { type: "extension_ui_closed", id: request.id });

  const controller = new AbortController();
  const confirm = ui.confirm("Confirm", "Continue?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirm, false);
  assert.equal(wrapper.pendingUiRequests.size, 0);
});

test("Stop cancels a custom UI factory that has not mounted yet", async (t) => {
  const { wrapper, ui, events } = setup(t);
  let finishFactory;
  let disposed = false;
  const pending = ui.custom(() => new Promise((resolve) => { finishFactory = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  await wrapper.send({ type: "abort" });
  await rejected;
  finishFactory({ render: () => ["Late panel"], dispose: () => { disposed = true; } });
  await nextTurn();
  assert.equal(disposed, true);
  assert.equal(events.some((event) => event.method === "custom"), false);
  assert.equal(wrapper.activeCustomUis.size, 0);
  await assert.rejects(ui.select("Reopen after Stop", ["A"]), { name: "AbortError" });
});

test("Stop before custom UI initialization does not invoke the factory", async (t) => {
  const { wrapper, ui } = setup(t);
  let invoked = false;
  const pending = ui.custom(() => { invoked = true; return { render: () => [] }; });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(invoked, false);
});
