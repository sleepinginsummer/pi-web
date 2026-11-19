import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

/** A local OpenAI-compatible endpoint that answers every chat request with one streamed reply. */
async function fakeModelServer(t, reply) {
  const requests = [];
  let releaseResponse;
  const waitForResponse = new Promise((resolve) => { releaseResponse = resolve; });
  const busyPromptStarted = Promise.withResolvers();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      requests.push(JSON.parse(body || "{}"));
      if (JSON.stringify(requests.at(-1).messages?.at(-1)?.content)?.includes("hold current turn")) {
        busyPromptStarted.resolve();
        await waitForResponse;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
      res.write(chunk({ role: "assistant", content: reply }));
      res.write(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }));
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { releaseResponse(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, busyPromptStarted: busyPromptStarted.promise, releaseResponse };
}

test("a wake reopens a session that has no live wrapper and runs a turn for the message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-wake-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const model = await fakeModelServer(t, "woken and handled");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: model.url, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "fake-model", input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "fake-model", retry: { enabled: false }, compaction: { enabled: false },
  }));

  // A session on disk that no wrapper holds, as after the page closed and the idle timeout reaped it.
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "start the build", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "started" }], timestamp: Date.now(),
    api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();

  const { getRpcSession } = await jiti.import("./rpc-manager.ts");
  const { wakeSession } = await jiti.import("./session-wake.ts");
  assert.equal(getRpcSession(sessionId), undefined);

  await wakeSession({
    sessionId,
    cwd,
    customType: "pi-web:background-command",
    content: "build exited with code 0",
    details: { commandId: "c0ffee00" },
    delivery: "followUp",
  });
  const wrapper = getRpcSession(sessionId);
  assert.ok(wrapper?.isAlive(), "the wake reopened the session");
  t.after(() => wrapper.shutdown());
  for (let i = 0; i < 300 && (wrapper.isRunning() || model.requests.length === 0); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(model.requests.length, 1, "one turn ran for the wake");
  assert.match(JSON.stringify(model.requests[0].messages), /build exited with code 0/);
  const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const woke = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === "pi-web:background-command");
  assert.ok(woke > 0, "the wake message is in the session file");
  assert.ok(entries.slice(woke).some((entry) => entry.type === "message" && entry.message.role === "assistant"
    && JSON.stringify(entry.message.content).includes("woken and handled")));

  const { saveStashedMessage, changeStashedMessage, listStashedMessages } = await jiti.import("./message-stash.ts");
  const { resolveStashProject, deliverDueStashedMessages } = await jiti.import("./message-stash-delivery.ts");
  const project = await resolveStashProject(cwd);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const saved = await saveStashedMessage(project, { text: "scheduled stash entry", images: [{ data: image, mimeType: "image/png" }] });
  await changeStashedMessage(project, saved.id, saved.revision, { at: Date.now() - 1, sessionId, label: "Test session" });
  await wrapper.send({ type: "prompt", message: "hold current turn" });
  await model.busyPromptStarted;
  await Promise.all([deliverDueStashedMessages(), deliverDueStashedMessages()]);
  const { queuedMessages } = await wrapper.send({ type: "get_state" });
  assert.equal(queuedMessages.steering.length, 0);
  assert.deepEqual(queuedMessages.followUp.map(({ text }) => text), ["scheduled stash entry"]);
  model.releaseResponse();
  for (let i = 0; i < 300 && (wrapper.isRunning() || model.requests.length < 2); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(model.requests.some(({ messages }) => messages.some(({ content }) => Array.isArray(content) && content.some(({ type }) => type === "image_url"))), "the attachment reaches the model");
  assert.deepEqual(listStashedMessages(project), []);
  const afterDelivery = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const deliveries = afterDelivery.filter((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("scheduled stash entry"));
  assert.equal(deliveries.length, 1, "it is saved as a regular user message");
  assert.ok(deliveries[0].message.content.some((block) => block.type === "image" && block.data));

  const unavailable = await saveStashedMessage(project, { text: "keep after delivery failure", images: [] });
  await changeStashedMessage(project, unavailable.id, unavailable.revision, { at: Date.now() - 1, sessionId: "no-such-session", label: "Deleted session" });
  await deliverDueStashedMessages();
  const [failed] = listStashedMessages(project);
  assert.equal(failed.id, unavailable.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.preview, "keep after delivery failure");
});

test("a wake for a session that no longer exists fails as permanent", async () => {
  const { wakeSession, SessionWakeError } = await jiti.import("./session-wake.ts");
  await assert.rejects(
    wakeSession({ sessionId: "no-such-session", cwd: tmpdir(), customType: "pi-web:scheduled-task", content: "x", delivery: "followUp" }),
    (error) => error instanceof SessionWakeError && error.permanent === true,
  );
});
