import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
// 观察员功能由 SESSION_OBSERVER_FEATURE_ENABLED 控制：它关闭时走 wrapper 的那条用例整体跳过，
// 而不是删掉——把开关改回 true 就该能直接跑。直接构造 SessionObserver 的用例不受影响。
const { SESSION_OBSERVER_FEATURE_ENABLED } = await jiti.import("./session-observer-protocol.ts");
const observerSkip = SESSION_OBSERVER_FEATURE_ENABLED ? false : "观察员功能已全局停用（SESSION_OBSERVER_FEATURE_ENABLED=false）";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const textResponse = (text = "") => ({ stopReason: "stop", content: [{ type: "text", text }] });

function reply(res, content, toolCall, finishReason = toolCall ? "tool_calls" : "stop") {
  const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({
    id: "test-response", object: "chat.completion.chunk", model: "fake-model", created: 1,
    choices: [{ index: 0, delta, finish_reason }], usage,
  })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, null));
  res.write(chunk({}, finishReason, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  res.end("data: [DONE]\n\n");
}

async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待观察状态超时");
}

test("会话观察默认关闭，支持可配置间隔和收尾补查，保留清单和摘要", { skip: observerSkip }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-observer-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const observed = [];
  const compacted = [];
  const main = [];
  let pendingResponse;
  let session;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = JSON.stringify(body.messages);
    if (messages.includes("将旧摘要与新增历史合并")) {
      compacted.push(body);
      reply(res, "旧配置的验证摘要");
      return;
    }
    if (!messages.includes("只维护极简高价值清单")) {
      main.push(body);
      const userIndex = body.messages.findLastIndex(({ role }) => role === "user");
      const user = body.messages[userIndex];
      const steps = /观察步骤=(\d+)/.exec(JSON.stringify(user?.content ?? ""));
      const completed = body.messages.slice(userIndex + 1).filter(({ role }) => role === "tool").length;
      if (steps && completed < Number(steps[1]) - 1) {
        reply(res, null, {
          index: 0, id: "observer-step-" + completed, type: "function",
          function: { name: "observer_checklist", arguments: '{"action":"list"}' },
        });
        return;
      }
      if (messages.includes("调用清单工具测试") && !body.messages.some(({ role }) => role === "tool")) {
        reply(res, null, {
          index: 0, id: "observer-test-call", type: "function",
          function: { name: "observer_checklist", arguments: JSON.stringify({ action: "add", title: "AI 新增事项", priority: "important" }) },
        });
        return;
      }
      reply(res, "主会话回复");
      return;
    }
    observed.push(body);
    if (observed.length === 5) {
      pendingResponse = res;
      return;
    }
    if (observed.length <= 3) {
      const input = observed.length === 1
        ? { action: "update", id: "missing", done: true }
        : observed.length === 2 ? { action: "add", title: "旧会话继续使用原配置" } : { action: "finish" };
      reply(res, null, { index: 0, id: "check-" + observed.length, type: "function",
        function: { name: "observer_checklist", arguments: JSON.stringify(input) },
      });
      return;
    }
    reply(res, "检查结束", undefined, observed.length === 6 ? "length" : "stop");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await session?.shutdown();
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [
      { id: "fake-model", contextWindow: 32_000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, reasoning: true, compat: { supportsReasoningEffort: true } },
      { id: "observer-model", contextWindow: 5_100, maxTokens: 4096, reasoning: true, compat: { supportsReasoningEffort: true } },
    ],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "fake-model", retry: { enabled: false }, compaction: { enabled: false },
  }));
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "检查配置", timestamp: 0 });
  for (let index = 0; index < 18; index++) {
    manager.appendMessage({ role: "user", content: `历史证据 ${index} ` + "验证配置".repeat(300), timestamp: 0 });
  }
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "开始检查" }], timestamp: 1,
    api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  manager.appendSessionInfo("会话观察测试");
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const { startRpcSession } = await jiti.import("./rpc-manager.ts");
  const { readObserverHistory, readObserverState } = await jiti.import("./session-observer-protocol.ts");
  ({ session } = await startRpcSession(id, file, cwd, { toolNames: ["read"] }));
  await session.waitUntilReady();

  let promptCount = 0;
  async function runSteps(count, suffix = "") {
    for (let i = 0; i < count; i++) {
      let settled = false;
      const off = session.onEvent((event) => { if (event.type === "agent_settled") settled = true; });
      try {
        await session.send({ type: "prompt", message: `步骤 ${++promptCount} ${suffix}` });
        await waitFor(() => settled && !session.isRunning());
      } finally {
        off();
      }
    }
  }

  assert.equal(session.sessionObserver.snapshot().enabled, false);
  await runSteps(6);
  assert.equal(observed.length, 0);
  assert.equal((await session.send({ type: "set_session_observer_enabled", enabled: true })).enabled, true);
  await session.shutdown();
  ({ session } = await startRpcSession(id, file, cwd));
  await session.waitUntilReady();
  await session.send({ type: "set_thinking_level", level: "low" });
  await runSteps(1, "观察步骤=10");
  await waitFor(() => session.sessionObserver.snapshot().items.length === 1);
  assert.equal(observed.length, 3);
  assert.equal(session.sessionObserver.snapshot().costUsd, 0.000009);
  assert.deepEqual(session.sessionObserver.snapshot().contextUsage, { tokens: 2, contextWindow: 32_000 });
  assert.deepEqual(observed[0].tools.map(({ function: tool }) => tool.name), ["observer_checklist"]);
  assert.match(observed[1].messages.at(-1).content, /没有该事项/);
  assert.match(observed[2].messages.at(-1).content, /已新增事项/);
  assert.ok(observed[0].messages[1].content.length > 18_000, "按模型窗口发送上下文，允许超过旧版固定字符上限");
  assert.equal(compacted.length, 0);
  assert.equal(observed[0].model, "fake-model");
  assert.equal(observed[0].reasoning_effort, "low");
  assert.equal(observed[0].max_completion_tokens ?? observed[0].max_tokens, 4096);
  const [first] = session.sessionObserver.snapshot().items;
  const edit = (input) => session.send({ type: "edit_session_observer_checklist", ...input });
  const added = await edit({ action: "add", title: "验证线上配置影响", priority: "urgent" });
  const second = added.items.at(-1);
  assert.deepEqual(added.items.map(({ id }) => id), [first.id, second.id]);
  await edit({ action: "move", id: second.id, beforeId: first.id });
  await edit({ action: "update", id: second.id, done: true });
  const third = (await edit({ action: "add", title: "待删除" })).items.at(-1);
  await edit({ action: "delete", id: third.id });
  const chosenModel = { provider: "fake", modelId: "observer-model" };
  const command = { type: "save_session_observer_settings", model: chosenModel, thinkingLevel: "high", interval: 8 };
  await assert.rejects(session.send({ ...command, thinkingLevel: "max" }), /does not support/);
  await assert.rejects(session.send({ ...command, interval: 0 }), /Invalid observer interval/);
  await assert.rejects(session.send({ ...command, focus: "invalid" }), /Invalid observer focus/);
  await assert.rejects(session.send({ ...command, focusNote: "x".repeat(301) }), /Invalid observer focus note/);
  assert.equal(session.sessionObserver.snapshot().enabled, true);
  await session.send(command);
  const restored = SessionManager.open(file);
  const diskState = readObserverState(id, restored.getEntries(), restored.getBranch());
  const entries = restored.getEntries();
  const checkEntry = entries.find((entry) => entry.data?.kind === "checked");
  assert.ok(checkEntry?.timestamp);
  assert.equal(first.createdAt, checkEntry.timestamp);
  assert.ok(second.createdAt);
  assert.equal(diskState.items.find(({ id }) => id === second.id).createdAt, second.createdAt);
  const [interaction] = readObserverHistory(id, restored.getEntries()).interactions;
  assert.equal(interaction.phase, "check");
  assert.equal(interaction.prompt, observed[0].messages[0].content);
  assert.ok(interaction.input === observed[0].messages[1].content, "保存完整的模型请求内容");
  const storedChecks = entries.filter((entry) => entry.data?.kind === "interaction" && entry.data.interaction.phase === "check");
  assert.equal(storedChecks.length, 3);
  assert.deepEqual(storedChecks.map(({ data }) => data.interaction.inputRef), [undefined, storedChecks[0].id, storedChecks[0].id]);
  assert.ok(storedChecks.slice(1).every(({ data }) => !("input" in data.interaction)));
  const storedBytes = Buffer.byteLength(JSON.stringify(storedChecks.map(({ data: { interaction: { input, inputRef } } }) => ({ input, inputRef }))));
  const inlineBytes = Buffer.byteLength(JSON.stringify(storedChecks.map(() => ({ input: interaction.input }))));
  assert.ok(inlineBytes - storedBytes > 36_000);
  assert.ok(readObserverHistory(id, entries).interactions.every((record) => record.input === interaction.input));
  assert.equal(interaction.output[0].type, "toolCall");
  assert.equal(JSON.parse(interaction.output[0].text).arguments.action, "finish");
  assert.match(interaction.toolResults[0].text, /已新增事项/);
  assert.equal(readObserverHistory(id, restored.getEntries()).interactions[1].toolResults[0].isError, true);
  assert.equal(diskState.costUsd, session.sessionObserver.snapshot().costUsd);
  assert.deepEqual(diskState.contextUsage, { tokens: 2, contextWindow: 32_000 });
  assert.equal(diskState.enabled, true);
  assert.deepEqual(diskState.preferences, { model: chosenModel, thinkingLevel: "high", interval: 8 });
  const savedRecords = restored.getEntries().filter((entry) => entry.type === "custom" && entry.data?.kind === "settings");
  assert.equal(savedRecords.length, 2);
  assert.ok(!("enabled" in savedRecords[1].data), "只修改模型时保留已经累计的步骤");
  assert.deepEqual(diskState.items.map(({ id, done, priority }) => ({ id, done, priority })), [
    { id: second.id, done: true, priority: "urgent" }, { id: first.id, done: false, priority: "normal" },
  ]);
  assert.deepEqual(readObserverState("other-session", restored.getEntries(), restored.getBranch()), {
    enabled: false, preferences: { model: null, thinkingLevel: null }, checking: false, items: [], costUsd: null,
  });

  await runSteps(1, "观察步骤=5 项目约束和工具证据".repeat(240));
  await waitFor(() => observed.length === 4 && !session.sessionObserver.snapshot().checking);
  assert.ok(compacted.length > 0);
  const records = readObserverHistory(id, session.inner.sessionManager.getEntries()).interactions;
  assert.equal(records[0].phase, "check");
  assert.ok(records.some(({ phase, output }) => phase === "summary" && output[0]?.text === "旧配置的验证摘要"));
  assert.match(JSON.stringify(observed[3].messages), /旧配置的验证摘要/);
  assert.equal(compacted[0].tools?.length ?? 0, 0);
  assert.ok(session.inner.sessionManager.getEntries().some((entry) => entry.data?.kind === "summary"));
  assert.deepEqual(session.sessionObserver.snapshot().items, diskState.items);
  assert.equal(observed[3].model, "observer-model");
  assert.equal(observed[3].reasoning_effort, "high");
  assert.ok(main.every((body) => body.model === "fake-model"));
  assert.equal(main.at(-1).reasoning_effort, "low");
  await session.send({ type: "save_session_observer_settings", model: null, thinkingLevel: null });
  assert.equal(main.some((body) => body.messages.some((message) => message.role === "system" && JSON.stringify(message).includes("验证线上配置影响"))), false);

  await runSteps(1);
  await waitFor(() => Boolean(pendingResponse));
  const off = await session.send({ type: "set_session_observer_enabled", enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.checking, false);
  const savedWhileDisabled = await session.send(command);
  assert.equal(savedWhileDisabled.enabled, false);
  assert.deepEqual(savedWhileDisabled.preferences, { model: chosenModel, thinkingLevel: "high", interval: 8 });
  if (!pendingResponse.destroyed) reply(pendingResponse, '[{"action":"add","title":"迟到结果"}]');
  await runSteps(6);
  assert.equal(observed.length, 5);
  assert.equal(session.sessionObserver.snapshot().items.length, 2);

  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-staged-test", "", cwd, { toolNames: [], observerEnabled: true }));
  assert.equal(session.sessionObserver.snapshot().enabled, true, "首条消息前已应用观察预设");
  await session.waitUntilReady();
  await session.send({ type: "set_session_name", name: "观察清单测试" });
  await runSteps(1);
  await waitFor(() => !session.sessionObserver.snapshot().checking);
  const [failedInteraction] = readObserverHistory(session.sessionId, session.inner.sessionManager.getEntries()).interactions;
  assert.equal(failedInteraction.status, "length");
  assert.equal(failedInteraction.failure, "outputLimit");
  assert.ok(!session.inner.sessionManager.getEntries().some((entry) => entry.data?.kind === "checked"));
  const created = SessionManager.open(session.sessionFile);
  assert.equal(readObserverState(session.sessionId, created.getEntries(), created.getBranch()).enabled, true);

  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-default-test", "", cwd, { toolNames: [] }));
  assert.equal(session.sessionObserver.snapshot().enabled, false, "同目录下一会话仍默认关闭");
  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-tools-test", "", cwd, { toolNames: ["read"] }));
  await session.waitUntilReady();
  await session.send({ type: "set_session_name", name: "观察清单测试" });
  assert.ok(session.inner.getActiveToolNames().includes("observer_checklist"));
  await runSteps(1, "调用清单工具测试");
  assert.deepEqual(session.sessionObserver.snapshot().items.map(({ title, priority }) => ({ title, priority })), [
    { title: "AI 新增事项", priority: "important" },
  ]);
});

test("失败的检查可以收尾补查，空结果也按分支恢复进度", async () => {
  const { SessionObserver } = await jiti.import("./session-observer.ts");
  const manager = SessionManager.inMemory();
  let requests = 0;
  let rejectFirst;
  const host = {
    sessionId: manager.getSessionId(),
    manager,
    canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({ inputBudget: 6000, request: () => {
      requests++;
      if (requests === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return Promise.resolve(textResponse());
    } }),
  };
  const step = (observer) => {
    const id = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "验证配置" }], timestamp: 1,
      api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
    observer.turnCompleted();
    return id;
  };
  let observer = new SessionObserver(host);
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null, interval: 2 });
  const branchPoint = step(observer);
  step(observer);
  observer.runSettled();
  await waitFor(() => typeof rejectFirst === "function");
  rejectFirst(new Error("fake observer failure"));
  await waitFor(() => requests === 2 && !observer.snapshot().checking);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.data.kind === "checked").length, 1);

  observer = new SessionObserver(host);
  step(observer);
  assert.equal(requests, 2, "重开会话后，一步还未达到设定间隔");
  observer.runSettled();
  await waitFor(() => requests === 3 && !observer.snapshot().checking);

  manager.branch(branchPoint);
  observer.restoreStepCount();
  step(observer);
  await waitFor(() => requests === 4 && !observer.snapshot().checking);
});

test("多批观察摘要各有独立期限，上一批超时信号不影响后续检查", async (t) => {
  const { SessionObserver } = await jiti.import("./session-observer.ts");
  const manager = SessionManager.inMemory();
  const deadlines = [];
  const phases = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 90_000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const observer = new SessionObserver({
    sessionId: manager.getSessionId(), manager, canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({ inputBudget: 2000, request: async (_prompt, _input, signal, phase) => {
      const previous = deadlines[phases.length - 1];
      previous?.abort(new DOMException("Expired", "TimeoutError"));
      signal.throwIfAborted();
      phases.push(phase);
      return textResponse(phase === "summary" ? "摘要" : "");
    } }),
  });
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null });
  for (let index = 0; index < 30; index++) {
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "证据".repeat(300) }], timestamp: index,
      api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  }
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking);
  assert.ok(phases.filter((phase) => phase === "summary").length > 1);
  assert.equal(phases.at(-1), "check");
  assert.equal(deadlines.length, phases.length);
  assert.ok(manager.getEntries().some((entry) => entry.data?.kind === "checked"));
});

test("单次观察超时后重试，普通文本中的 JSON 不会修改清单", async (t) => {
  const { SessionObserver } = await jiti.import("./session-observer.ts");
  const manager = SessionManager.inMemory();
  let timeout;
  const prompts = [];
  t.mock.method(AbortSignal, "timeout", () => {
    timeout = new AbortController();
    return timeout.signal;
  });
  const observer = new SessionObserver({
    sessionId: manager.getSessionId(), manager, canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({ inputBudget: 6000, request: async (prompt, _input, signal) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        timeout.abort(new DOMException("Expired", "TimeoutError"));
        signal.throwIfAborted();
      }
      return textResponse('[{"action":"add","title":"普通文本里的事项"}]');
    } }),
  });
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "记录待验证事项" }], timestamp: 1,
    api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.deepEqual(observer.snapshot().items, []);
  assert.equal(manager.getEntries().filter((entry) => entry.data?.kind === "checked").length, 1);
});

test("观察续轮压缩证据、保留工具结果，纠错后零修改也完成检查", async () => {
  const { SessionObserver, observerModelTools } = await jiti.import("./session-observer.ts");
  const { estimateTextTokens, estimateMessageTokens } = await import("@earendil-works/pi-ai/utils/estimate");
  const manager = SessionManager.inMemory();
  const inputBudget = 2400;
  const phases = [];
  let checks = 0;
  const observer = new SessionObserver({
    sessionId: manager.getSessionId(), manager, canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({ inputBudget, request: async (prompt, input, _signal, phase, continuation) => {
      phases.push(phase);
      if (phase === "summary") return textResponse("已压缩的较早证据");
      const tokens = estimateTextTokens(prompt) + estimateTextTokens(input) + estimateTextTokens(JSON.stringify(observerModelTools))
        + continuation.reduce((total, message) => total + estimateMessageTokens(message), 0);
      assert.ok(tokens <= inputBudget, `续轮输入 ${tokens} 超过预算 ${inputBudget}`);
      checks++;
      if (checks === 2) {
        assert.match(input, /已压缩的较早证据/);
        assert.doesNotMatch(input, /最早证据/);
        assert.equal(continuation.at(-1).toolCallId, "list-1");
        assert.equal(continuation.at(-1).isError, true);
      }
      if (checks === 3) {
        assert.deepEqual(continuation.filter(({ role }) => role === "toolResult").map(({ toolCallId, isError }) => [toolCallId, isError]), [
          ["list-1", true], ["list-2", false],
        ]);
        return { stopReason: "toolUse", content: [{ type: "toolCall", id: "finish", name: "observer_checklist", arguments: { action: "finish" } }] };
      }
      return { stopReason: "toolUse", content: [
        ...(checks === 1 ? [{ type: "thinking", thinking: "思".repeat(4300) }] : []),
        { type: "toolCall", id: `list-${checks}`, name: "observer_checklist", arguments: { action: "list", offset: checks === 1 ? -1 : 0 } },
      ] };
    } }),
  });
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null });
  for (const title of ["最早证据", "中间证据", "最新证据"]) {
    manager.appendMessage({ role: "user", content: title + "证据".repeat(650), timestamp: 1 });
  }
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking);
  assert.deepEqual(phases, ["check", "summary", "check", "check"]);
  assert.deepEqual(manager.getEntries().find((entry) => entry.data?.kind === "checked")?.data.edits, []);
  observer.runSettled();
  assert.equal(observer.snapshot().checking, false);
});

test("工具报错后直接结束不会提交已暂存的清单修改", async () => {
  const { SessionObserver } = await jiti.import("./session-observer.ts");
  const manager = SessionManager.inMemory();
  let requests = 0;
  const observer = new SessionObserver({
    sessionId: manager.getSessionId(), manager, canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({ inputBudget: 6000, request: async () => {
      if (++requests > 1) return textResponse("结束");
      return { stopReason: "toolUse", content: [
        { type: "toolCall", name: "observer_checklist", id: "add", arguments: { action: "add", title: "暂存事项" } },
        { type: "toolCall", name: "observer_checklist", id: "bad", arguments: { action: "update", id: "missing", done: true } },
      ] };
    } }),
  });
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null });
  manager.appendMessage({ role: "user", content: "需要检查的事项", timestamp: 1 });
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking);
  assert.equal(requests, 2);
  assert.deepEqual(observer.snapshot().items, []);
  assert.ok(!manager.getEntries().some((entry) => entry.data?.kind === "checked"));
});

test("观察交互跨页还原原文，兼容旧记录和缺失引用", async () => {
  const { readObserverHistory, SESSION_OBSERVER_ENTRY } = await jiti.import("./session-observer-protocol.ts");
  const sessionId = "observer-history";
  const interaction = (id, evidence, owner = sessionId) => ({
    type: "custom", id, customType: SESSION_OBSERVER_ENTRY,
    data: { sessionId: owner, version: 1, kind: "interaction", interaction: { ...evidence, status: "stop", costUsd: 0.01 } },
  });
  const entries = [
    interaction("old", { input: "旧版完整记录" }),
    interaction("original", { input: "首次检查原文" }),
    interaction("compressed", { input: "压缩后的原文" }),
    interaction("foreign", { input: "另一会话的原文" }, "other-session"),
    ...Array.from({ length: 10 }, (_, index) => interaction(`ref-${index}`, { inputRef: "original" })),
    interaction("newest", { inputRef: "compressed" }),
    interaction("missing", { inputRef: "not-found" }),
    interaction("wrong-session", { inputRef: "foreign" }),
  ];
  const first = readObserverHistory(sessionId, entries);
  assert.equal(first.interactions.length, 10);
  assert.deepEqual(first.interactions.slice(0, 4).map(({ input }) => input), [null, null, "压缩后的原文", "首次检查原文"]);
  assert.equal(first.nextBefore, "ref-3");
  assert.ok(first.interactions.every((record) => !("inputRef" in record) && record.costUsd === 0.01));
  const previous = readObserverHistory(sessionId, entries, first.nextBefore);
  assert.deepEqual(previous.interactions.map(({ input }) => input), ["首次检查原文", "首次检查原文", "首次检查原文", "压缩后的原文", "首次检查原文", "旧版完整记录"]);
  assert.equal(previous.nextBefore, null);
});

test("观察输入包含当前清单与增量分界，支持 delete 清理、关注重点与面板排序", async () => {
  const { SessionObserver, buildCheckPrompt } = await jiti.import("./session-observer.ts");
  const { partitionObserverItems } = await jiti.import("./observer-checklist.ts");
  const manager = SessionManager.inMemory();
  const captured = [];
  let round = 0;
  const observer = new SessionObserver({
    sessionId: manager.getSessionId(),
    manager,
    canWrite: () => true,
    append: (type, data) => manager.appendCustomEntry(type, data),
    model: () => ({
      inputBudget: 6000,
      request: async (prompt, input) => {
        captured.push({ prompt, input });
        round++;
        if (round === 1) {
          return {
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "add-1", name: "observer_checklist", arguments: { action: "add", title: "临时旧条目", priority: "normal" } }],
          };
        }
        if (round === 2) return textResponse();
        if (round === 3) {
          const id = observer.snapshot().items[0].id;
          return {
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "del-1", name: "observer_checklist", arguments: { action: "delete", id } },
              { type: "toolCall", id: "add-2", name: "observer_checklist", arguments: { action: "add", title: "确认权限边界", priority: "urgent" } },
            ],
          };
        }
        return textResponse();
      },
    }),
  });

  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null, focus: "risks", focusNote: "重点检查权限边界" });
  assert.equal(observer.snapshot().preferences.focus, "risks");
  assert.equal(observer.snapshot().preferences.focusNote, "重点检查权限边界");
  assert.match(buildCheckPrompt({ focus: "risks", focusNote: "重点检查权限边界" }), /只记已暴露的风险/);
  assert.match(buildCheckPrompt({ focus: "risks", focusNote: "重点检查权限边界" }), /重点检查权限边界/);

  manager.appendMessage({ role: "user", content: "第一轮需求", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "第一轮答复" }], timestamp: 2, api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking && observer.snapshot().items.length === 1);
  assert.match(captured[0].prompt, /只记已暴露的风险/);
  assert.match(captured[0].prompt, /重点检查权限边界/);
  assert.match(captured[0].input, /当前清单\n（空）/);
  assert.doesNotMatch(captured[0].input, /以上为上次检查过的历史/);

  manager.appendMessage({ role: "user", content: "第二轮新增报错", timestamp: 3 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "发现越权风险" }], timestamp: 4, api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  observer.turnCompleted();
  observer.runSettled();
  await waitFor(() => !observer.snapshot().checking && observer.snapshot().items[0]?.title === "确认权限边界");

  assert.match(captured[2].input, /临时旧条目/, "第二轮检查输入应直接附带当前清单");
  assert.match(captured[2].input, /以上为上次检查过的历史，以下为本次新增对话/, "第二轮检查输入应标出增量分界");
  assert.deepEqual(observer.snapshot().items.map(({ title, priority }) => ({ title, priority })), [
    { title: "确认权限边界", priority: "urgent" },
  ]);

  // 切回 balanced 并清空 focusNote 后，偏好不再保留冗余字段。
  observer.saveSettings({ enabled: true, model: null, thinkingLevel: null, focus: "balanced", focusNote: "   " });
  assert.deepEqual(observer.snapshot().preferences, { model: null, thinkingLevel: null });

  const partitioned = partitionObserverItems([
    { id: "1", title: "普通项 A", done: false, priority: "normal" },
    { id: "2", title: "已完成紧急", done: true, priority: "urgent" },
    { id: "3", title: "重要项", done: false, priority: "important" },
    { id: "4", title: "紧急项", done: false, priority: "urgent" },
    { id: "5", title: "普通项 B", done: false, priority: "normal" },
    { id: "6", title: "已完成普通", done: true, priority: "normal" },
  ]);
  assert.deepEqual(partitioned.open.map(({ id }) => id), ["4", "3", "1", "5"]);
  assert.deepEqual(partitioned.done.map(({ id }) => id), ["2", "6"]);
});
