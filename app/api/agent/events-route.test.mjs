import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const eventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE projects SDK events onto the fields consumed by the web client", () => {
  assert.match(agentEventsSource, /createAgentEventStream/);
  assert.match(agentEventsSource, /onEvent: \(event\) =>/);
  assert.match(agentEventsSource, /isSessionFlushBoundaryEvent\(event\)/);
  assert.match(eventStreamSource, /toClientAgentEvent\(event\)/);
  assert.match(eventStreamSource, /message_start/);
});

test("agent SSE reuses one TextEncoder for preparation and live events", { timeout: 2000 }, async t => {
  const { createAgentEventStream } = await createJiti(import.meta.url).import("../../../lib/agent-event-stream.ts");
  const abort = new AbortController();
  const request = new Request("http://localhost/events", { signal: abort.signal });
  const OriginalEncoder = globalThis.TextEncoder;
  let encoders = 0;
  globalThis.TextEncoder = class extends OriginalEncoder { constructor() { super(); encoders++; } };
  t.after(() => { abort.abort(); globalThis.TextEncoder = OriginalEncoder; });
  let listener;
  const stream = createAgentEventStream(request, "encoder", Promise.resolve({
    isStreaming: false, streamingMessage: undefined,
    onEvent(callback) { listener = callback; callback({ type: "extension_ui_request", id: "pending", method: "notify" }); return () => {}; },
  }));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), ":\n\n");
  for (const type of ["connected", "extension_ui_request"]) {
    assert.equal(JSON.parse(decoder.decode((await reader.read()).value).slice(6)).type, type);
  }
  listener({ type: "bash_output", output: "live" });
  assert.equal(JSON.parse(decoder.decode((await reader.read()).value).slice(6)).output, "live");
  assert.equal(encoders, 1);
});
