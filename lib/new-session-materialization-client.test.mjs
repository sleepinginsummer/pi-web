import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isNewSessionMaterializationResult } = await jiti.import("./new-session-protocol.ts");
const { materializeNewSession, releaseNewSessionMaterialization } = await jiti.import("./new-session-materialization-client.ts");

const ready = {
  kind: "ready",
  success: true,
  sessionId: "session-1",
  data: null,
  model: null,
  shadowMindEnabled: false,
  shadowMindAvailable: true,
};

test("新会话 wire guard 拒绝缺失 sessionId 的响应", () => {
  assert.equal(isNewSessionMaterializationResult(ready), true);
  assert.equal(isNewSessionMaterializationResult({ ...ready, sessionId: undefined }), false);
  assert.equal(isNewSessionMaterializationResult({ ...ready, model: {} }), false);
});

test("同一 cwd 的创建请求跨调用方复用", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let submittedBody;
  globalThis.fetch = async (_input, init) => {
    submittedBody = JSON.parse(init.body);
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, status: 200, json: async () => ready };
  };
  try {
    const request = { operation: "create", cwd: "/tmp/pi-web-materialize-test", toolNames: [], shadowMindEnabled: false };
    const [first, second] = await Promise.all([
      materializeNewSession(request),
      materializeNewSession(request),
    ]);
    assert.equal(calls, 1);
    assert.equal(submittedBody.operation, "create");
    assert.equal(submittedBody.shadowMindEnabled, false);
    assert.deepEqual(first, ready);
    assert.deepEqual(second, ready);
  } finally {
    releaseNewSessionMaterialization("/tmp/pi-web-materialize-test");
    globalThis.fetch = originalFetch;
  }
});
