import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { NotificationNavigationGate } = await jiti.import("./notification-navigation-gate.ts");

test("ignores an old notification response after manual navigation", async () => {
  const gate = new NotificationNavigationGate();
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const generation = gate.begin();
  const selected = [];
  const completion = request.then((sessionId) => {
    if (gate.isCurrent(generation)) selected.push(sessionId);
  });

  gate.invalidate();
  resolveRequest("notification-session");
  await completion;

  assert.deepEqual(selected, []);
});

test("accepts the current notification response", async () => {
  const gate = new NotificationNavigationGate();
  const generation = gate.begin();
  const selected = [];

  await Promise.resolve("notification-session").then((sessionId) => {
    if (gate.isCurrent(generation)) selected.push(sessionId);
  });

  assert.deepEqual(selected, ["notification-session"]);
});
