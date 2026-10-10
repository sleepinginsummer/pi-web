import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isNewSessionMaterializationResult, isNewSessionRuntimeCreated } = await jiti.import("./new-session-protocol.ts");
const { materializeNewSession, releaseNewSessionMaterialization, resetCreationOperationsForTests } = await jiti.import("./new-session-materialization-client.ts");

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
  // 扩展绑定状态是可选的，但出现时类型必须正确。
  assert.equal(isNewSessionMaterializationResult({ ...ready, extensionsInitializing: true }), true);
  assert.equal(isNewSessionMaterializationResult({ ...ready, extensionsInitializing: "yes" }), false);
  assert.equal(isNewSessionMaterializationResult({ ...ready, extensionsError: null }), true);
  assert.equal(isNewSessionMaterializationResult({ ...ready, extensionsError: "bind failed" }), true);
  assert.equal(isNewSessionMaterializationResult({ ...ready, extensionsError: 3 }), false);
});

test("runtime-created 只交付身份，不能当成初始化完成", () => {
  const created = { kind: "runtime-created", success: true, sessionId: "session-1" };
  assert.equal(isNewSessionRuntimeCreated(created), true);
  assert.equal(isNewSessionRuntimeCreated({ ...created, sessionId: "" }), false);
  assert.equal(isNewSessionRuntimeCreated({ ...created, success: false }), false);
  assert.equal(isNewSessionMaterializationResult(created), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("先交付真实 ID 并连接 SSE，随后才提交一次 finalize；跨调用方复用两个阶段", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = "/tmp/pi-web-two-phase";
  const bodies = [];
  const connected = deferred();
  const callbacksStarted = deferred();
  let callbacks = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { status: 200, json: async () => body.operation === "create"
      ? { kind: "runtime-created", success: true, sessionId: "session-1" }
      : ready };
  };
  try {
    const request = { operation: "create", cwd, shadowMindEnabled: false, toolNames: ["read"] };
    const attach = async (sessionId) => {
      assert.equal(sessionId, "session-1");
      if (++callbacks === 2) callbacksStarted.resolve();
      await connected.promise;
    };
    const first = materializeNewSession(request, attach);
    const second = materializeNewSession(request, attach);
    await callbacksStarted.promise;
    assert.equal(bodies.length, 1, "未连接事件流不能等待扩展初始化");
    connected.resolve();
    assert.deepEqual(await Promise.all([first, second]), [ready, ready]);
    assert.deepEqual(bodies.map((body) => body.operation), ["create", "finalize-existing"]);
    assert.equal(bodies[1].sessionId, "session-1");
    assert.equal(bodies[1].shadowMindEnabled, false);
    assert.deepEqual(bodies[1].toolNames, ["read"]);
  } finally {
    releaseNewSessionMaterialization(cwd);
    globalThis.fetch = originalFetch;
  }
});

test("事件流连接失败保留真实 ID；重试先连接事件流且不会重建会话", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = "/tmp/pi-web-two-phase-recovery";
  const operations = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    operations.push(body.operation);
    return { status: 200, json: async () => body.operation === "create"
      ? { kind: "runtime-created", success: true, sessionId: "session-1" }
      : ready };
  };
  try {
    const failed = await materializeNewSession({ operation: "create", cwd, shadowMindEnabled: false }, async () => {
      throw new Error("SSE connection failed");
    });
    assert.deepEqual(failed, {
      kind: "materialization-failed", success: false, sessionId: "session-1", error: "SSE connection failed",
    });
    assert.deepEqual(operations, ["create"]);
    releaseNewSessionMaterialization(cwd);
    const result = await materializeNewSession(
      { operation: "finalize-existing", sessionId: failed.sessionId, cwd, shadowMindEnabled: false },
      async (sessionId) => {
        assert.equal(sessionId, failed.sessionId);
        assert.deepEqual(operations, ["create"]);
      },
    );
    assert.deepEqual(result, ready);
    assert.deepEqual(operations, ["create", "finalize-existing"]);
  } finally {
    releaseNewSessionMaterialization(cwd);
    globalThis.fetch = originalFetch;
  }
});

test("创建失败不留下虚假 runtime 身份", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = "/tmp/pi-web-create-failure";
  globalThis.fetch = async () => { throw new Error("network failure"); };
  try {
    await assert.rejects(materializeNewSession({ operation: "create", cwd, shadowMindEnabled: true }, async () => {}), /network failure/);
  } finally {
    releaseNewSessionMaterialization(cwd);
    globalThis.fetch = originalFetch;
  }
});

test("请求超时给出可重试的错误，不留下虚假 runtime 身份", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = "/tmp/pi-web-create-timeout";
  let sawSignal = false;
  globalThis.fetch = async (_input, init) => {
    sawSignal = init.signal instanceof AbortSignal;
    throw new DOMException("The operation timed out", "TimeoutError");
  };
  try {
    await assert.rejects(
      materializeNewSession({ operation: "create", cwd, shadowMindEnabled: true }, async () => {}),
      /新会话请求超过 30s 未响应/,
    );
    assert.equal(sawSignal, true, "请求必须带上限，静默排队不能变成永久等待");
  } finally {
    releaseNewSessionMaterialization(cwd);
    globalThis.fetch = originalFetch;
  }
});

test("创建响应超时后重试沿用同一个 operationId，服务端才能交回同一 runtime", async () => {
  const originalFetch = globalThis.fetch;
  const cwd = "/tmp/pi-web-create-timeout-retry";
  const operationIds = [];
  let createAttempts = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    if (body.operation !== "create") {
      return { status: 200, json: async () => ready };
    }
    operationIds.push(body.operationId);
    createAttempts += 1;
    if (createAttempts === 1) throw new DOMException("The operation timed out", "TimeoutError");
    return { status: 200, json: async () => ({ kind: "runtime-created", success: true, sessionId: "session-1" }) };
  };
  try {
    await assert.rejects(
      materializeNewSession({ operation: "create", cwd, shadowMindEnabled: true }, async () => {}),
      /新会话请求超过 30s 未响应/,
    );
    // 超时只说明结果未知：服务端可能已经建好，重试必须复用同一创建意图。
    const created = await materializeNewSession({ operation: "create", cwd, shadowMindEnabled: true }, async () => {});
    assert.equal(created.sessionId, "session-1");
    assert.equal(operationIds.length, 2);
    assert.equal(typeof operationIds[0], "string");
    assert.equal(operationIds[0], operationIds[1], "重试不得生成新的创建意图");
  } finally {
    releaseNewSessionMaterialization(cwd);
    resetCreationOperationsForTests();
    globalThis.fetch = originalFetch;
  }
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
      materializeNewSession(request, async () => {}),
      materializeNewSession(request, async () => {}),
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
