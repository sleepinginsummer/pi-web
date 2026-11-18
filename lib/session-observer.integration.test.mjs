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

function reply(res, content) {
  const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({
    id: "test-response", object: "chat.completion.chunk", model: "fake-model", created: 1,
    choices: [{ index: 0, delta, finish_reason }], usage,
  })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content }, null));
  res.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  res.end("data: [DONE]\n\n");
}

async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待观察状态超时");
}

test("会话观察默认关闭，每六个模型步骤检测，持久化反馈并丢弃关闭后的结果", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-observer-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const observed = [];
  const main = [];
  let pendingResponse;
  let session;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!JSON.stringify(body.messages).includes("你是当前会话的独立观察员")) {
      main.push(body);
      reply(res, "主会话回复");
      return;
    }
    observed.push(body);
    if (observed.length === 3) {
      pendingResponse = res;
      return;
    }
    reply(res, observed.length === 1
      ? JSON.stringify({ note: { title: "旧会话继续使用原配置", detail: "新配置只影响之后创建的会话。" } })
      : JSON.stringify({ note: null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await session?.shutdown();
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [
      { id: "fake-model", contextWindow: 32_000, maxTokens: 4096, reasoning: true, compat: { supportsReasoningEffort: true } },
      { id: "observer-model", contextWindow: 32_000, maxTokens: 4096, reasoning: true, compat: { supportsReasoningEffort: true } },
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
  ({ session } = await startRpcSession(id, file, cwd, { toolNames: [] }));
  await session.waitUntilReady();

  let promptCount = 0;
  async function runSteps(count) {
    for (let i = 0; i < count; i++) {
      let settled = false;
      const off = session.onEvent((event) => { if (event.type === "agent_settled") settled = true; });
      try {
        await session.send({ type: "prompt", message: `步骤 ${++promptCount}` });
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
  await runSteps(5);
  assert.equal(observed.length, 0);
  await session.shutdown();
  ({ session } = await startRpcSession(id, file, cwd));
  await session.waitUntilReady();
  await session.send({ type: "set_thinking_level", level: "low" });
  await runSteps(1);
  await waitFor(() => session.sessionObserver.snapshot().cards.length === 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].tools?.length ?? 0, 0);
  assert.equal(observed[0].model, "fake-model");
  assert.equal(observed[0].reasoning_effort, "low");
  const [card] = session.sessionObserver.snapshot().cards;
  assert.equal(session.inner.sessionManager.getEntry(card.anchorId)?.type, "message");

  await session.send({ type: "submit_session_observer_feedback", noteId: card.id, kind: "reply", text: "仅反馈线上配置影响" });
  const chosenModel = { provider: "fake", modelId: "observer-model" };
  const command = { type: "save_session_observer_settings", model: chosenModel, thinkingLevel: "high" };
  await assert.rejects(session.send({ ...command, thinkingLevel: "max" }), /does not support/);
  assert.equal(session.sessionObserver.snapshot().enabled, true);
  await session.send(command);
  const restored = SessionManager.open(file);
  const diskState = readObserverState(id, restored.getEntries(), restored.getBranch());
  assert.equal(diskState.enabled, true);
  assert.deepEqual(diskState.preferences, { model: chosenModel, thinkingLevel: "high" });
  const savedRecords = restored.getEntries().filter((entry) => entry.type === "custom" && entry.data?.kind === "settings");
  assert.equal(savedRecords.length, 2);
  assert.ok(!("enabled" in savedRecords[1].data), "只修改模型时保留已经累计的步骤");
  assert.deepEqual(diskState.cards[0].feedback, [{ kind: "reply", text: "仅反馈线上配置影响" }]);
  assert.equal(readObserverState(id, restored.getEntries(), restored.getBranch(card.anchorId)).cards.length, 0);
  assert.deepEqual(readObserverState("other-session", restored.getEntries(), restored.getBranch()), {
    enabled: false, preferences: { model: null, thinkingLevel: null }, checking: false, cards: [],
  });

  await runSteps(6);
  await waitFor(() => observed.length === 2 && !session.sessionObserver.snapshot().checking);
  assert.match(JSON.stringify(observed[1].messages), /仅反馈线上配置影响/);
  assert.equal(observed[1].model, "observer-model");
  assert.equal(observed[1].reasoning_effort, "high");
  assert.ok(main.every((body) => body.model === "fake-model"));
  assert.equal(main.at(-1).reasoning_effort, "low");
  await session.send({ type: "save_session_observer_settings", model: null, thinkingLevel: null });
  assert.equal(main.some((body) => JSON.stringify(body.messages).includes("仅反馈线上配置影响")), false);

  await runSteps(6);
  await waitFor(() => Boolean(pendingResponse));
  const off = await session.send({ type: "set_session_observer_enabled", enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.checking, false);
  const savedWhileDisabled = await session.send(command);
  assert.equal(savedWhileDisabled.enabled, false);
  assert.deepEqual(savedWhileDisabled.preferences, { model: chosenModel, thinkingLevel: "high" });
  if (!pendingResponse.destroyed) reply(pendingResponse, '{"note":{"title":"迟到结果","detail":"不应出现"}}');
  await runSteps(6);
  assert.equal(observed.length, 3);
  assert.equal(session.sessionObserver.snapshot().cards.length, 1);

  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-staged-test", "", cwd, { toolNames: [], observerEnabled: true }));
  assert.equal(session.sessionObserver.snapshot().enabled, true, "首条消息前已应用观察预设");
  await session.waitUntilReady();
  await runSteps(1);
  const created = SessionManager.open(session.sessionFile);
  assert.equal(readObserverState(session.sessionId, created.getEntries(), created.getBranch()).enabled, true);

  await session.shutdown();
  ({ session } = await startRpcSession("__new__observer-default-test", "", cwd, { toolNames: [] }));
  assert.equal(session.sessionObserver.snapshot().enabled, false, "同目录下一会话仍默认关闭");
});
