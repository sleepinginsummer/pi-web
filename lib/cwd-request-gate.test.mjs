import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CwdRequestGate } = await jiti.import("./cwd-request-gate.ts");

test("rejects a trust response after switching cwd", async () => {
  const gate = new CwdRequestGate();
  gate.setCwd("/repo/a");
  const ticket = gate.begin("/repo/a");
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const committed = [];
  const completion = request.then((value) => {
    if (gate.isCurrent(ticket)) committed.push(value);
  });

  gate.setCwd("/repo/b");
  resolveRequest("trusted-a");
  await completion;

  assert.deepEqual(committed, []);
});

test("accepts the trust response for the current cwd", () => {
  const gate = new CwdRequestGate();
  gate.setCwd("/repo/a");
  assert.equal(gate.isCurrent(gate.begin("/repo/a")), true);
});

test("a newer request for the same cwd invalidates the pending request", async () => {
  const gate = new CwdRequestGate();
  gate.setCwd("/repo/a");
  const getTicket = gate.begin("/repo/a");
  const postTicket = gate.begin("/repo/a");

  assert.equal(gate.isCurrent(postTicket), true);
  assert.equal(gate.isCurrent(getTicket), false);
});
