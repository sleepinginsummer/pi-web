import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { prewarmLayoutEventStream } from "../e2e/responsive-layout.mjs";

const jiti = createJiti(import.meta.url);
const {
  countAgentEventStreams,
  createAgentEventStream,
  listAgentEventStreams,
  TOOL_UPDATE_COALESCE_MS,
} = await jiti.import("./agent-event-stream.ts");
const { hasActiveSessionLivenessProvider } = await jiti.import("./session-liveness.ts");
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  assert.match(text, /^data: /);
  return JSON.parse(text.slice("data: ".length));
}

test("extension shutdown forwards its terminal event before closing the stream", async () => {
  let listener;
  let unsubscribed = false;
  const stream = createAgentEventStream(new Request("http://localhost/events"), "ended", Promise.resolve({
    isStreaming: false,
    isAlive: () => true,
    onEvent(callback) { listener = callback; return () => { unsubscribed = true; }; },
  }));
  const reader = stream.getReader();
  await readWithin(reader); // transport
  await readWithin(reader); // connected
  listener({ type: "extension_ui_request", id: "cleanup", method: "notify", message: "File retained", notifyType: "warning" });
  listener({ type: "session_ended", sessionId: "ended" });
  assert.equal(decodeData(await readWithin(reader)).message, "File retained");
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "session_ended", sessionId: "ended" });
  assert.equal((await readWithin(reader)).done, true);
  assert.equal(unsubscribed, true);
});

test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  const transport = await readWithin(reader);
  assert.equal(decoder.decode(transport.value), ":\n\n");

  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      subscribeCount += 1;
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => { unsubscribeCount += 1; };
    },
  });

  const connected = decodeData(await readWithin(reader));
  const messageStart = decodeData(await readWithin(reader));
  const replayedEvent = decodeData(await readWithin(reader));
  assert.equal(subscribeCount, 1);
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: true,
    pendingExtensionUiIds: [],
  });
  assert.deepEqual(messageStart, { type: "agent_start" });
  assert.deepEqual(replayedEvent, { type: "message_start", message: snapshot });
  // The page's lease renewals keep the session alive (renewIdleTimer()), not its stream:
  // a hidden page lets go of the stream (#1283).
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), false);

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "!" },
  });

  abortController.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), false);
  assert.equal((await readWithin(reader)).done, true);
});

test("reports a startup failure in-band after opening the transport", async () => {
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.reject(new Error("broken config")),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "startup_error",
    errorMessage: "Failed to start agent: broken config",
  });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the client cancels during startup", async () => {
  const startup = deferred();
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader);
  await reader.cancel();
  startup.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() {
      subscribeCount += 1;
      return () => {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCount, 0);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "session-id" }), false);
});

test("session_shutdown from a live wrapper closes the SSE stream", async () => {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => true,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  decodeData(await readWithin(reader));
  listener({ type: "session_shutdown" });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the wrapper died before the snapshot", async () => {
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => false,
      onEvent() {
        subscribeCount += 1;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  assert.equal((await readWithin(reader)).done, true);
  assert.equal(subscribeCount, 0);
});

test("closes an already-aborted request and handles a later startup rejection", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.reject(new Error("startup failed after disconnect")),
  );

  assert.equal((await readWithin(stream.getReader())).done, true);
  await new Promise((resolve) => setImmediate(resolve));
});

async function connectedStream(sessionId) {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    sessionId,
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "connected",
    sessionId,
    isStreaming: true,
    pendingExtensionUiIds: [],
  });
  return { reader, listener, abortController };
}

test("connected names the extension UI requests the session replays, so a client can drop the rest", async () => {
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "ui-session",
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(nextListener) {
        // What AgentSessionWrapper.onEvent() replays: pending UI requests, then running tools.
        nextListener({ type: "extension_ui_request", id: "dialog-b", method: "confirm", title: "Run?" });
        nextListener({ type: "extension_ui_request", id: "panel-c", method: "custom", lines: [] });
        nextListener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");

  const connected = decodeData(await readWithin(reader));
  assert.deepEqual(connected.pendingExtensionUiIds, ["dialog-b", "panel-c"]);
  // The replayed requests follow it, so the client re-queues what it had dropped.
  assert.equal(decodeData(await readWithin(reader)).id, "dialog-b");
  assert.equal(decodeData(await readWithin(reader)).id, "panel-c");
  abortController.abort();
});

const BIG_PAYLOAD = "x".repeat(30_000);

function toolUpdate(toolCallId = "call-1", partialResult = BIG_PAYLOAD) {
  return {
    type: "tool_execution_update",
    toolCallId,
    toolName: "bash",
    partialResult,
  };
}

/** Non-droppable, so it always survives and marks the end of the queued batch. */
function sentinelEvent() {
  return { type: "agent_end" };
}

/** Wait until the stream has flushed the tool updates it was coalescing. */
function afterCoalesceWindow() {
  return new Promise((resolve) => setTimeout(resolve, TOOL_UPDATE_COALESCE_MS * 2));
}

test("terminates the stream when an unread, non-rebuildable backlog exceeds the limit", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
  try {
    const { reader, listener } = await connectedStream("backlog-session");

    // Stop reading here: message snapshots cannot be rebuilt client-side, so
    // they must hit the hard limit instead of being dropped.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let index = 0; index < 8; index += 1) {
      listener({ type: "message_start", message });
    }

    let queuedChunks = 0;
    await assert.rejects(async () => {
      for (;;) {
        const next = await readWithin(reader);
        if (next.done) return;
        queuedChunks += 1;
        assert.ok(queuedChunks < 8, "stream kept queueing past the backlog limit");
      }
    }, /client backlog exceeded/);
    assert.equal(hasActiveSessionLivenessProvider({ sessionId: "backlog-session" }), false);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("drops rebuildable deltas while the client is behind instead of disconnecting it", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("behind-session");

    // Updates of different tool calls survive coalescing and are written in one flush.
    const emitted = 60;
    for (let index = 0; index < emitted; index += 1) listener(toolUpdate(`call-${index}`));
    await afterCoalesceWindow();
    listener(sentinelEvent());

    // Whatever was queued before the water mark is still delivered…
    let delivered = 0;
    let sawSentinel = false;
    while (!sawSentinel) {
      const next = await readWithin(reader);
      assert.equal(next.done, false);
      const event = decodeData(next);
      if (event.type === "agent_end") sawSentinel = true;
      else delivered += 1;
    }
    assert.ok(delivered > 0 && delivered < emitted, `expected drops, delivered ${delivered} of ${emitted}`);

    // …and the stream stays usable once the client catches up.
    listener(toolUpdate());
    const afterCatchUp = await readWithin(reader);
    assert.equal(afterCatchUp.done, false);
    assert.equal(decodeData(afterCatchUp).type, "tool_execution_update");
    abortController.abort();
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("keeps the start and end of a streamed block while dropping its deltas", async (t) => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("block-session");
    t.after(() => abortController.abort());
    const update = (assistantMessageEvent) => ({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent,
    });

    listener(update({ type: "text_start", contentIndex: 0 }));
    for (let index = 0; index < 60; index += 1) {
      listener(update({ type: "text_delta", contentIndex: 0, delta: BIG_PAYLOAD }));
    }
    // The client's reducer replaces the block with this content, repairing any dropped delta.
    listener(update({ type: "text_end", contentIndex: 0, content: "final text" }));
    listener(sentinelEvent());

    const kinds = [];
    for (;;) {
      const event = decodeData(await readWithin(reader));
      if (event.type === "agent_end") break;
      kinds.push(event.assistantMessageEvent.type);
    }
    assert.equal(kinds[0], "text_start");
    assert.equal(kinds.at(-1), "text_end");
    assert.ok(kinds.length < 62, `expected dropped deltas, got ${kinds.length} events`);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("delivers every update to a client that reads promptly", async () => {
  const { reader, listener, abortController } = await connectedStream("prompt-session");
  for (let index = 0; index < 5; index += 1) {
    listener(toolUpdate("call-1", `${index}:${BIG_PAYLOAD}`));
    const next = await readWithin(reader);
    assert.equal(next.done, false);
    const event = decodeData(next);
    assert.equal(event.type, "tool_execution_update");
    assert.equal(event.partialResult, `${index}:${BIG_PAYLOAD}`);
  }
  abortController.abort();
});

test("coalesces a burst of tool updates into the latest one per tool call", async (t) => {
  const { reader, listener, abortController } = await connectedStream("coalesce-session");
  t.after(() => abortController.abort());

  // A codemode script publishes a snapshot each time a nested call starts.
  for (let index = 0; index < 50; index += 1) {
    if (index % 10 === 0) {
      listener({
        type: "tool_execution_start",
        toolCallId: `call-codemode/${index + 1}`,
        toolName: "read",
        args: { path: `file-${index}` },
        parentToolCallId: "call-codemode",
      });
      // The nested call's own progress never reaches the client.
      listener({
        ...toolUpdate(`call-codemode/${index + 1}`, `nested ${index}`),
        toolName: "read",
        parentToolCallId: "call-codemode",
      });
    }
    listener({ ...toolUpdate("call-codemode", `snapshot ${index}`), toolName: "codemode" });
  }
  listener(toolUpdate("call-bash", "bash tail"));

  // Starts are never held back for the updates around them.
  const starts = [];
  for (let index = 0; index < 5; index += 1) starts.push(decodeData(await readWithin(reader)));
  assert.deepEqual(starts.map((event) => event.toolCallId), [
    "call-codemode/1",
    "call-codemode/11",
    "call-codemode/21",
    "call-codemode/31",
    "call-codemode/41",
  ]);
  assert.deepEqual(starts[0], {
    type: "tool_execution_start",
    toolCallId: "call-codemode/1",
    toolName: "read",
    parentToolCallId: "call-codemode",
  });

  const updates = [decodeData(await readWithin(reader)), decodeData(await readWithin(reader))];
  assert.deepEqual(
    updates.map((event) => [event.type, event.toolCallId, event.partialResult]),
    [
      ["tool_execution_update", "call-codemode", "snapshot 49"],
      ["tool_execution_update", "call-bash", "bash tail"],
    ],
  );

  await afterCoalesceWindow();
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });
});

test("never delivers a tool update after that tool call's end", async (t) => {
  const { reader, listener, abortController } = await connectedStream("end-session");
  t.after(() => abortController.abort());

  listener(toolUpdate("call-1", "partial"));
  listener(toolUpdate("call-2", "still running"));
  listener({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: BIG_PAYLOAD }] },
    isError: false,
  });

  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
  });
  // Only the ended call's pending update is discarded.
  const other = decodeData(await readWithin(reader));
  assert.equal(other.toolCallId, "call-2");
  assert.equal(other.partialResult, "still running");

  await afterCoalesceWindow();
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });
});

test("discards pending tool updates when the run ends", async (t) => {
  const { reader, listener, abortController } = await connectedStream("run-end-session");
  t.after(() => abortController.abort());

  listener(toolUpdate("call-1", "no end ever came"));
  listener(sentinelEvent());
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_end" });

  await afterCoalesceWindow();
  listener({ type: "agent_settled" });
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "agent_settled" });
});

test("replays a running tool's start and latest update after the snapshot", async () => {
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "replay-session",
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(listener) {
        // AgentSessionWrapper.onEvent() replays active tool calls synchronously.
        listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "make" } });
        listener(toolUpdate("call-1", "latest output"));
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);

  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "make" },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), toolUpdate("call-1", "latest output"));
  abortController.abort();
});

test("reconnect snapshots and live completions omit signatures without changing the snapshot", async (t) => {
  const abortController = new AbortController();
  t.after(() => abortController.abort());
  const snapshot = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "思考🙂", thinkingSignature: "opaque-provider-state" },
      { type: "text", text: "回答", textSignature: "message-id" },
    ],
  };
  const original = JSON.stringify(snapshot);
  let listener;
  let unsubscribed = false;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "signed-snapshot",
    Promise.resolve({
      isStreaming: true,
      streamingMessage: snapshot,
      onEvent(nextListener) {
        listener = nextListener;
        nextListener({ type: "message_start", message: snapshot });
        return () => { unsubscribed = true; };
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  const displayMessage = { role: "assistant", content: [
    { type: "thinking", thinking: "思考🙂" },
    { type: "text", text: "回答" },
  ] };
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "message_start", message: displayMessage });
  listener({ type: "message_end", message: snapshot });
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "message_end", message: displayMessage });
  assert.equal(JSON.stringify(snapshot), original);
  abortController.abort();
  assert.equal(unsubscribed, true);
  assert.equal((await readWithin(reader)).done, true);
});

test("sends a heartbeat data event the browser's EventSource can see", async (t) => {
  const { AGENT_EVENT_HEARTBEAT_MS } = await jiti.import("./agent-event-wire.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { reader, abortController } = await connectedStream("heartbeat-session");
  t.after(() => abortController.abort());

  t.mock.timers.tick(AGENT_EVENT_HEARTBEAT_MS);
  // An SSE comment (":") never reaches EventSource, so a dead stream could not be told apart.
  assert.deepEqual(decodeData(await readWithin(reader)), { type: "heartbeat" });
});

// ── Debug panel: the stream registry ─────────────────────────────────────────

const listedStreams = (sessionId) => listAgentEventStreams().filter((stream) => stream.sessionId === sessionId);

test("lists a stream from its start with its holder and client, then when it connected and last wrote", async (t) => {
  let now = 5_000_000;
  t.mock.method(Date, "now", () => now);
  const startup = deferred();
  const abortController = new AbortController();
  const totalBefore = countAgentEventStreams();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "debug-listed",
    startup.promise,
    { holder: "page-1", address: "192.168.1.20", client: "Safari · iOS" },
  );
  const reader = stream.getReader();
  await readWithin(reader);

  // Counted while the session is still starting, before `connected`.
  assert.deepEqual(listedStreams("debug-listed"), [{
    sessionId: "debug-listed",
    holder: "page-1",
    address: "192.168.1.20",
    client: "Safari · iOS",
    openedAt: 5_000_000,
    connectedAt: null,
    lastWriteAt: 5_000_000,
    droppedEvents: 0,
    queuedBytes: 0,
  }]);
  assert.equal(countAgentEventStreams(), totalBefore + 1);

  now += 1_000;
  startup.resolve({ isStreaming: false, streamingMessage: undefined, onEvent: () => () => {} });
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  const [connected] = listedStreams("debug-listed");
  assert.equal(connected.connectedAt, 5_001_000);
  assert.equal(connected.lastWriteAt, 5_001_000);

  abortController.abort();
  assert.deepEqual(listedStreams("debug-listed"), []);
  assert.equal(countAgentEventStreams(), totalBefore);
});

test("a stream opened without a holder is listed with none", async () => {
  const { abortController } = await connectedStream("debug-no-holder");
  assert.equal(listedStreams("debug-no-holder")[0]?.holder, null);
  assert.equal(listedStreams("debug-no-holder")[0]?.address, null);
  assert.equal(listedStreams("debug-no-holder")[0]?.client, null);
  abortController.abort();
  assert.deepEqual(listedStreams("debug-no-holder"), []);
});

test("every way a stream ends takes it off the list", async () => {
  const ends = {
    async cancel() {
      const { reader } = await connectedStream("debug-end-cancel");
      await reader.cancel();
      return "debug-end-cancel";
    },
    async shutdown() {
      const { reader, listener } = await connectedStream("debug-end-shutdown");
      listener({ type: "session_shutdown" });
      assert.equal((await readWithin(reader)).done, true);
      return "debug-end-shutdown";
    },
    async startupError() {
      const stream = createAgentEventStream(
        new Request("http://localhost/events"),
        "debug-end-startup",
        Promise.reject(new Error("broken config")),
      );
      const reader = stream.getReader();
      await readWithin(reader);
      assert.equal(decodeData(await readWithin(reader)).type, "startup_error");
      assert.equal((await readWithin(reader)).done, true);
      return "debug-end-startup";
    },
    async deadWrapper() {
      const stream = createAgentEventStream(
        new Request("http://localhost/events"),
        "debug-end-dead",
        Promise.resolve({ isStreaming: false, streamingMessage: undefined, isAlive: () => false, onEvent: () => () => {} }),
      );
      const reader = stream.getReader();
      await readWithin(reader);
      assert.equal((await readWithin(reader)).done, true);
      return "debug-end-dead";
    },
    async alreadyAborted() {
      const abortController = new AbortController();
      abortController.abort();
      createAgentEventStream(
        new Request("http://localhost/events", { signal: abortController.signal }),
        "debug-end-aborted",
        new Promise(() => {}),
      );
      return "debug-end-aborted";
    },
    async backlog() {
      const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
      process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
      try {
        const { reader, listener } = await connectedStream("debug-end-backlog");
        const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
        for (let index = 0; index < 8; index += 1) listener({ type: "message_start", message });
        await assert.rejects(async () => {
          for (;;) if ((await readWithin(reader)).done) return;
        }, /client backlog exceeded/);
      } finally {
        if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
        else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
      }
      return "debug-end-backlog";
    },
  };
  for (const [name, end] of Object.entries(ends)) {
    const sessionId = await end();
    assert.deepEqual(listedStreams(sessionId), [], `${name} leaves no entry`);
  }
});

test("counts dropped deltas and the bytes the client has not read", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { listener, abortController } = await connectedStream("debug-behind");
    // Unread messages fill the queue past the water mark; the deltas after them are dropped.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let index = 0; index < 20; index += 1) listener({ type: "message_start", message });
    for (let index = 0; index < 3; index += 1) {
      listener({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
    }
    const [behind] = listedStreams("debug-behind");
    assert.equal(behind.droppedEvents, 3);
    assert.ok(behind.queuedBytes > 512 * 1024, `queued ${behind.queuedBytes}`);
    abortController.abort();
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});


async function replayFailureChunks(phase) {
  let unsubscribed = 0;
  const event = phase === "projection"
    ? { type: "message_start", message: { get role() { throw new Error("事件转换失败"); } } }
    : { type: "extension_ui_request", id: "pending", method: "notify", message: "回放" };
  if (phase === "serialization") event.extra = 1n;
  const stream = createAgentEventStream(new Request("http://localhost/events"), "replay-failure", Promise.resolve({
    isStreaming: true,
    streamingMessage: phase === "snapshot" ? { role: "assistant", content: [], extra: 1n } : undefined,
    onEvent(callback) {
      callback({ type: "extension_ui_request", id: "earlier", method: "notify", message: "已准备的回放" });
      callback(event);
      return () => { unsubscribed++; };
    },
  }), { onEvent(event) { if (phase === "hook" && event.id === "pending") throw new Error("回放钩子失败"); } });
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await readWithin(reader);
    if (done) break;
    chunks.push(value);
  }
  assert.equal(unsubscribed, 1, "失败时解除订阅且只解除一次");
  return chunks;
}

for (const phase of ["hook", "projection", "serialization", "snapshot"]) {
  test(`回放准备失败前不宣告 connected：${phase}`, async () => {
    const chunks = await replayFailureChunks(phase);
    const events = chunks.map(value => decoder.decode(value)).filter(text => text.startsWith("data: "))
      .map(text => JSON.parse(text.slice("data: ".length)));
    assert.deepEqual(events.map(event => event.type), ["startup_error"]);
    assert.ok(events[0].errorMessage.includes(phase === "hook" ? "回放钩子失败" : phase === "projection" ? "事件转换失败" : "BigInt"));
  });
}

function mockPartitionedStream(t, chunks, partition) {
  const combined = Buffer.concat(chunks);
  const parts = partition === "merged" ? [combined]
    : partition === "bytes" ? Array.from(combined, byte => Uint8Array.of(byte)) : chunks;
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    } }));
  });
  return () => assert.equal(signal.aborted, true);
}

for (const partition of ["merged", "frames", "bytes"]) {
  test(`真实生产者的回放失败在不同分块下均报完整错误：${partition}`, async t => {
    const chunks = await replayFailureChunks("hook");
    const checkClosed = mockPartitionedStream(t, chunks, partition);
    await assert.rejects(prewarmLayoutEventStream("http://fixture", "replay-failure"), error =>
      error.message.includes("replay-failure") && error.message.includes("回放钩子失败"));
    checkClosed();
  });

  test(`真实生产者的成功回放在不同分块下均就绪：${partition}`, async t => {
    const abort = new AbortController();
    const stream = createAgentEventStream(new Request("http://localhost/events", { signal: abort.signal }), "replay-success", Promise.resolve({
      isStreaming: false, streamingMessage: undefined,
      onEvent(callback) {
        callback({ type: "extension_ui_request", id: "pending", method: "notify", message: "回放" });
        return () => {};
      },
    }));
    const reader = stream.getReader();
    const chunks = [];
    try {
      for (let i = 0; i < 3; i++) chunks.push((await readWithin(reader)).value);
    } finally { abort.abort(); }
    const checkClosed = mockPartitionedStream(t, chunks, partition);
    await prewarmLayoutEventStream("http://fixture", "replay-success");
    checkClosed();
  });
}


for (const kind of ["ui", "tool"]) {
  test(`回放只序列化一次，并复用准备好的帧：${kind}`, async t => {
    const abort = new AbortController();
    t.after(() => abort.abort());
    let serialized = 0;
    const payload = { toJSON() {
      serialized++;
      assert.equal(serialized, 1, "发送或合并刷新时不应再次序列化");
      return { value: "ready" };
    } };
    const event = kind === "ui"
      ? { type: "extension_ui_request", id: "pending", method: "notify", details: payload }
      : { type: "tool_execution_update", toolCallId: "tool", toolName: "bash", partialResult: payload };
    const stream = createAgentEventStream(new Request("http://localhost/events", { signal: abort.signal }), "prepared", Promise.resolve({
      isStreaming: false, streamingMessage: undefined,
      onEvent(callback) { callback(event); return () => {}; },
    }));
    const reader = stream.getReader();
    await readWithin(reader);
    assert.equal(decodeData(await readWithin(reader)).type, "connected");
    const replay = decodeData(await readWithin(reader));
    assert.equal(replay.type, event.type);
    assert.deepEqual(kind === "ui" ? replay.details : replay.partialResult, { value: "ready" });
    assert.equal(serialized, 1);
  });
}


function initialReplay(t, id, events, snapshot, limit) {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  if (limit !== undefined) process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(limit);
  const abort = new AbortController();
  let listener;
  t.after(() => {
    abort.abort();
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  });
  const stream = createAgentEventStream(new Request("http://localhost/events", { signal: abort.signal }), id, Promise.resolve({
    isStreaming: snapshot !== undefined, streamingMessage: snapshot,
    onEvent(callback) { listener = callback; for (const event of events) callback(event); return () => {}; },
  }));
  const reader = stream.getReader();
  return { reader, async drain() {
    await afterCoalesceWindow();
    listener({ type: "agent_settled" });
    const frames = [];
    for (;;) {
      const chunk = await readWithin(reader);
      const event = decodeData(chunk);
      if (event.type === "agent_settled") return frames;
      frames.push({ event, bytes: chunk.value.byteLength });
    }
  } };
}

const INITIAL_REPLAY_LIMIT = 64 * 1024;

test("初始回放先合并工具更新，过期及已结束更新不序列化", async t => {
  let obsolete = 0;
  const expired = { toJSON() { obsolete++; throw new Error("过期更新不应序列化"); } };
  const events = [
    toolUpdate("previous-run", expired),
    { type: "agent_end" },
    { type: "tool_execution_start", toolCallId: "active", toolName: "bash" },
    ...Array.from({ length: 30 }, () => toolUpdate("active", expired)),
    toolUpdate("active", "latest"),
    toolUpdate("ended", expired),
    { type: "tool_execution_end", toolCallId: "ended", toolName: "bash" },
  ];
  const { reader, drain } = initialReplay(t, "initial-coalesced", events);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  const frames = await drain();
  assert.equal(obsolete, 0);
  assert.deepEqual(frames.filter(frame => frame.event.type === "tool_execution_update").map(frame => frame.event.partialResult), ["latest"]);
});

test("单帧进度超限后省略其余并行工具，避免继续分配序列化副本", async t => {
  const id = "initial-parallel-oversize";
  let serialized = 0;
  const events = Array.from({ length: 12 }, (_, index) => toolUpdate(`tool-${index}`, {
    toJSON() { serialized++; return "x".repeat(INITIAL_REPLAY_LIMIT * 2); },
  }));
  const { reader, drain } = initialReplay(t, id, events, undefined, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.equal(serialized, 1, "只允许一次超限候选序列化用于计量");
  assert.equal(listedStreams(id)[0].droppedEvents, events.length);
  assert.deepEqual(await drain(), []);
});

test("准备预算按 UTF-8 累计字节计量，并保留能装下的并行工具进度", async t => {
  const id = "initial-utf8-budget";
  let serialized = 0;
  const events = Array.from({ length: 8 }, (_, index) => toolUpdate(`tool-${index}`, {
    toJSON() { serialized++; return "中".repeat(10_000); },
  }));
  const { reader, drain } = initialReplay(t, id, events, undefined, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  const connected = await readWithin(reader);
  assert.equal(decodeData(connected).type, "connected");
  assert.equal(serialized, 3);
  assert.equal(listedStreams(id)[0].droppedEvents, 6);
  const frames = await drain();
  assert.equal(frames.length, 2);
  assert.ok(connected.value.byteLength + frames.reduce((bytes, frame) => bytes + frame.bytes, 0) <= INITIAL_REPLAY_LIMIT);
});

test("准备阶段沿用高水位规则，后续可重建快照不再序列化", async t => {
  const id = "initial-high-water";
  let serialized = 0;
  const events = Array.from({ length: 6 }, (_, index) => toolUpdate(`tool-${index}`, {
    toJSON() { serialized++; return "x".repeat(300_000); },
  }));
  const { reader, drain } = initialReplay(t, id, events, undefined, 16 * 1024 * 1024);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.equal(serialized, 2);
  assert.equal(listedStreams(id)[0].droppedEvents, 4);
  assert.equal((await drain()).length, 2);
});

test("先给必要回放和快照留预算，进度不能挤占它们", async t => {
  const id = "initial-required-first";
  const snapshot = { role: "assistant", content: [{ type: "text", text: "s".repeat(15_000) }] };
  const events = [toolUpdate("tool", "p".repeat(20_000)),
    { type: "extension_ui_request", id: "required", method: "notify", message: "u".repeat(35_000) }];
  const { reader, drain } = initialReplay(t, id, events, snapshot, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.equal(listedStreams(id)[0].droppedEvents, 1);
  const frames = await drain();
  assert.deepEqual(frames.map(frame => frame.event.type), ["extension_ui_request", "message_start"]);
});

test("必要帧累计超限时只发启动错误，不先发 connected 或部分回放", async t => {
  const snapshot = { role: "assistant", content: [{ type: "text", text: "中".repeat(12_000) }] };
  const events = [{ type: "extension_ui_request", id: "required", method: "notify", message: "中".repeat(12_000) }];
  const { reader } = initialReplay(t, "initial-required-overflow", events, snapshot, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  const error = decodeData(await readWithin(reader));
  assert.equal(error.type, "startup_error");
  assert.equal(error.code, "sse_replay_budget_exceeded");
  assert.equal(error.retryable, false);
  assert.match(error.errorMessage, /initial replay preparation.*exceed/i);
  assert.equal((await readWithin(reader)).done, true);
});

test("初始工具进度在快照后发送，保留每个工具的最新更新", async t => {
  const snapshot = { role: "assistant", content: [{ type: "text", text: "running" }] };
  const events = [{ type: "tool_execution_start", toolCallId: "tool", toolName: "bash" }, toolUpdate("tool", "old"), toolUpdate("tool", "latest")];
  const { reader, drain } = initialReplay(t, "initial-order", events, snapshot);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  const frames = await drain();
  assert.deepEqual(frames.map(frame => frame.event.type), ["tool_execution_start", "message_start", "tool_execution_update"]);
  assert.equal(frames[2].event.partialResult, "latest");
});


test("就绪帧自身也占准备预算，超限时不继续序列化 UI 回放", async t => {
  let serialized = 0;
  const events = Array.from({ length: 4 }, (_, index) => ({
    type: "extension_ui_request", id: `${index}:${"x".repeat(20_000)}`, method: "notify",
    details: { toJSON() { serialized++; return "unused"; } },
  }));
  const { reader } = initialReplay(t, "initial-ready-budget", events, undefined, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  const event = decodeData(await readWithin(reader));
  assert.equal(event.type, "startup_error");
  assert.match(event.errorMessage, /initial replay preparation.*exceed/i);
  assert.equal(serialized, 0);
});

test("必要回放超限后停止准备后续帧", async t => {
  let later = 0;
  const events = [
    { type: "extension_ui_request", id: "first", method: "notify", message: "x".repeat(36_000) },
    { type: "extension_ui_request", id: "second", method: "notify", message: "x".repeat(36_000) },
    { type: "extension_ui_request", id: "later", method: "notify", details: { toJSON() { later++; throw new Error("不应到达"); } } },
  ];
  const { reader } = initialReplay(t, "initial-stop-required", events, undefined, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  const event = decodeData(await readWithin(reader));
  assert.equal(event.type, "startup_error");
  assert.match(event.errorMessage, /initial replay preparation.*exceed/i);
  assert.equal(later, 0);
});

test("普通可重建输出和正文增量也服从准备高水位", async t => {
  const id = "initial-optional-events";
  let serialized = 0;
  const payload = { toJSON() { serialized++; return "x".repeat(1_000_000); } };
  const events = [
    { type: "bash_output", output: payload },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: payload } },
  ];
  const snapshot = { role: "assistant", content: [{ type: "text", text: "s".repeat(600_000) }] };
  const { reader, drain } = initialReplay(t, id, events, snapshot, 16 * 1024 * 1024);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.equal(serialized, 0);
  assert.equal(listedStreams(id)[0].droppedEvents, 2);
  assert.deepEqual((await drain()).map(frame => frame.event.type), ["message_start"]);
});


test("必要回放在 connected 前编码，发布复用准备好的同一字节数组", async t => {
  const allocated = [];
  let allocatedAtReady;
  const originalEncode = TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype, "encode", function(text) {
    const data = originalEncode.call(this, text);
    if (typeof text === "string" && text.includes('"message":"allocation-')) allocated.push(data);
    return data;
  });
  const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
  t.mock.method(ReadableStreamDefaultController.prototype, "enqueue", function(data) {
    const text = decoder.decode(data);
    if (text.startsWith("data: ") && JSON.parse(text.slice(6)).type === "connected") allocatedAtReady = [...allocated];
    return originalEnqueue.call(this, data);
  });
  const events = Array.from({ length: 4 }, (_, index) => ({
    type: "extension_ui_request", id: `allocation-${index}`, method: "notify", message: `allocation-${index}:${"x".repeat(14_000)}`,
  }));
  const { reader } = initialReplay(t, "initial-byte-ownership", events, undefined, INITIAL_REPLAY_LIMIT);
  await readWithin(reader);
  assert.equal(decodeData(await readWithin(reader)).type, "connected");
  assert.equal(allocatedAtReady.length, 4, "就绪时全部必要帧应已编码");
  for (let index = 0; index < 4; index++) assert.equal((await readWithin(reader)).value, allocatedAtReady[index]);
  assert.equal(allocated.length, 4, "发布不能再次编码载荷");
});
