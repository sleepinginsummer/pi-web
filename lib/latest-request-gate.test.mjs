import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LatestRequestGate } = await jiti.import("./latest-request-gate.ts");

test("同一会话只允许最新请求提交，且不同会话互不影响", () => {
  const gate = new LatestRequestGate();
  const oldA = gate.begin("session-a");
  const onlyB = gate.begin("session-b");
  const newA = gate.begin("session-a");

  assert.equal(gate.isLatest("session-a", oldA), false);
  assert.equal(gate.isLatest("session-a", newA), true);
  assert.equal(gate.isLatest("session-b", onlyB), true);

  gate.finish("session-a");
  assert.equal(gate.isLatest("session-a", newA), true, "old request still in flight keeps latest generation");
  gate.finish("session-a");
  assert.equal(gate.isLatest("session-a", newA), false, "last completion releases the session key");
  assert.equal(gate.isLatest("session-b", onlyB), true, "cleaning session-a does not affect session-b");

  const nextA = gate.begin("session-a");
  assert.ok(nextA > newA, "released keys still use a monotonic sequence and cannot revive old responses");
  gate.invalidate("session-a");
  assert.equal(gate.isLatest("session-a", nextA), false, "invalidate prevents an unmounted request from committing");
  gate.finish("session-a");
  assert.equal(gate.isLatest("session-a", nextA), false);
});
