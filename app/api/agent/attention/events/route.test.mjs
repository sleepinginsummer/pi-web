import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const managerSource = await readFile(new URL("../../../../../lib/rpc-manager.ts", import.meta.url), "utf8");
const attentionSource = await readFile(new URL("../../../../../lib/attention-events.ts", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../../../../../hooks/useGlobalAttentionNotifications.ts", import.meta.url), "utf8");

test("global attention stream forwards normalized attention events from every RPC session", () => {
  assert.match(managerSource, /private emit\(event: AgentEvent\): void \{[\s\S]*?publishAttentionEvent\(this\.sessionId, event\)/);
  assert.doesNotMatch(managerSource, /__piAttentionListeners/);
  assert.match(attentionSource, /type AttentionSourceEvent = AttentionToolEvent \| ExtensionUiRequest/);
  assert.match(attentionSource, /event\.type === "tool_execution_start" && event\.toolName === "ask_user_question"/);
  assert.match(attentionSource, /const shouldSuppressDialog = \(sessionAskCalls\?\.size \?\? 0\) > 0/);
  assert.match(attentionSource, /request\.method === "select" \|\| request\.method === "input"/);
  assert.match(routeSource, /subscribeAttentionEvents\(\(event\) =>/);
  assert.doesNotMatch(routeSource, /tool_execution_start|extension_ui_request/);
});

test("attention notification hook subscribes independently of the selected session", () => {
  assert.match(hookSource, /new EventSource\("\/api\/agent\/attention\/events"\)/);
  assert.match(hookSource, /notifySessionRef\.current\(title, body, event\.sessionId\)/);
});
