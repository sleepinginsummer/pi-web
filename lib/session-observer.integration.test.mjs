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
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function reply(res, content, toolCall) {
  const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({
    id: "test-response", object: "chat.completion.chunk", model: "fake-model", created: 1,
    choices: [{ index: 0, delta, finish_reason }], usage,
  })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, null));
  res.write(chunk({}, toolCall ? "tool_calls" : "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  res.end("data: [DONE]\n\n");
}

async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待观察状态超时");
}

test("会话观察默认关闭，支持可配置间隔和收尾补查，保留清单和摘要", async (t) => {
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
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const messages = JSON.stringify(body.messages);
    if (messages.includes("将旧摘要与新增历史合并")) {
      compacted.push(body);
      reply(res, "旧配置的验证摘要");
      return;
    }
    if (!messages.includes("把重要且尚未记录的行动事项加入清单")) {
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
    if (observed.length === 3) {
      pendingResponse = res;
      return;
    }
    reply(res, observed.length === 1
      ? JSON.stringify([{ action: "add", title: "旧会话继续使用原配置" }])
      : "[]");
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
      { id: "fake-model", contextWindow: 32_000, maxTokens: 4096, reasoning: true, compat: { supportsReasoningEffort: true } },
      { id: "observer-model", contextWindow: 6_000, maxTokens: 4096, reasoning: true, compat: { supportsReasoningEffort: true } },
    ],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "fake-model", retry: { enabled: false }, compaction: { enabled: false },
  }));
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "检查配置", timestamp: 0 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "开始检查" }], timestamp: 1,
    api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop", usage });
  manager.appendSessionInfo("会话观察测试");
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const { startRpcSession } = await jiti.import("./rpc-manager.ts");
  const { readObserverState } = await jiti.import("./session-observer-protocol.ts");
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
  await runSteps(1, "观察步骤=6");
  await waitFor(() => session.sessionObserver.snapshot().items.length === 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].tools?.length ?? 0, 0);
  assert.equal(observed[0].model, "fake-model");
  assert.equal(observed[0].reasoning_effort, "low");
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
  assert.equal(session.sessionObserver.snapshot().enabled, true);
  await session.send(command);
  const restored = SessionManager.open(file);
  const diskState = readObserverState(id, restored.getEntries(), restored.getBranch());
  assert.equal(diskState.enabled, true);
  assert.deepEqual(diskState.preferences, { model: chosenModel, thinkingLevel: "high", interval: 8 });
  const savedRecords = restored.getEntries().filter((entry) => entry.type === "custom" && entry.data?.kind === "settings");
  assert.equal(savedRecords.length, 2);
  assert.ok(!("enabled" in savedRecords[1].data), "只修改模型时保留已经累计的步骤");
  assert.deepEqual(diskState.items.map(({ id, done, priority }) => ({ id, done, priority })), [
    { id: second.id, done: true, priority: "urgent" }, { id: first.id, done: false, priority: "normal" },
  ]);
  assert.deepEqual(readObserverState("other-session", restored.getEntries(), restored.getBranch()), {
    enabled: false, preferences: { model: null, thinkingLevel: null }, checking: false, items: [],
  });

  await runSteps(1, "观察步骤=5 项目约束和工具证据".repeat(240));
  await waitFor(() => observed.length === 2 && !session.sessionObserver.snapshot().checking);
  assert.ok(compacted.length > 0);
  assert.match(JSON.stringify(observed[1].messages), /旧配置的验证摘要/);
  assert.match(JSON.stringify(observed[1].messages), /验证线上配置影响/);
  assert.ok(session.inner.sessionManager.getEntries().some((entry) => entry.data?.kind === "summary"));
  assert.deepEqual(session.sessionObserver.snapshot().items, diskState.items);
  assert.equal(observed[1].model, "observer-model");
  assert.equal(observed[1].reasoning_effort, "high");
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
  assert.equal(observed.length, 3);
  assert.equal(session.sessionObserver.snapshot().items.length, 2);

  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-staged-test", "", cwd, { toolNames: [], observerEnabled: true }));
  assert.equal(session.sessionObserver.snapshot().enabled, true, "首条消息前已应用观察预设");
  await session.waitUntilReady();
  await session.send({ type: "set_session_name", name: "观察清单测试" });
  await runSteps(1);
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
      return Promise.resolve("[]");
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
