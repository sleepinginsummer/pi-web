import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const eventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE projects SDK events onto the fields consumed by the web client", () => {
  assert.match(agentEventsSource, /createAgentEventStream/);
  assert.match(agentEventsSource, /onEvent: \(event\) =>/);
  assert.match(agentEventsSource, /isSessionFlushBoundaryEvent\(event\)/);
  assert.match(eventStreamSource, /toClientAgentEvent\(event\)/);
  assert.match(eventStreamSource, /message_start/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((eventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(eventStreamSource, /controller\.enqueue\(encoder\.encode\(text\)\)/);
  assert.match(eventStreamSource, /enqueueText\(":\\n\\n"\)|controller\.enqueue\(encoder\.encode\(":\\n\\n"\)\)/);
});
