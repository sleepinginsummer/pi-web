import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_PENDING_NEW_SESSION_CONTROL,
  reducePendingNewSession,
  selectPendingNewSession,
} = await jiti.import("./pending-new-session.ts");

test("待创建会话按显式事件完成创建状态迁移", () => {
  const disabled = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_SHADOW", enabled: false });
  const materializing = reducePendingNewSession(disabled, { type: "START" });
  const ready = reducePendingNewSession(materializing, { type: "READY", sessionId: "session-1" });

  assert.deepEqual(disabled, { kind: "staged", shadowMindEnabled: false, model: null, thinkingLevel: "auto" });
  assert.deepEqual(materializing, { kind: "materializing", shadowMindEnabled: false, model: null, thinkingLevel: "auto" });
  assert.deepEqual(ready, { kind: "materialized", sessionId: "session-1" });
});

test("待创建会话保留已选模型和思考强度", () => {
  const model = { provider: "test", modelId: "model-a" };
  const selected = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_MODEL", model });
  const configured = reducePendingNewSession(selected, { type: "SET_THINKING_LEVEL", level: "high" });

  assert.deepEqual(configured, {
    kind: "staged",
    shadowMindEnabled: true,
    model,
    thinkingLevel: "high",
  });
});

test("post-start 失败保留 real id，并通过 recovering 重试同一会话", () => {
  const materializing = { kind: "materializing", shadowMindEnabled: false };
  const failed = reducePendingNewSession(materializing, {
    type: "POST_START_FAIL",
    sessionId: "session-1",
    error: "finalize failed",
  });
  const recovering = reducePendingNewSession(failed, { type: "RETRY" });
  const ready = reducePendingNewSession(recovering, { type: "READY", sessionId: "session-1" });

  assert.deepEqual(failed, {
    kind: "materialization-failed",
    shadowMindEnabled: false,
    sessionId: "session-1",
    error: "finalize failed",
  });
  assert.deepEqual(selectPendingNewSession(recovering), {
    busy: true,
    shadowPending: true,
    desiredShadowMindEnabled: false,
    transportSessionId: "session-1",
    shadowMode: "staged",
  });
  assert.deepEqual(ready, { kind: "materialized", sessionId: "session-1" });
});

test("初始化失败只能显式恢复默认开启，且不丢失 real id", () => {
  const failed = {
    kind: "initialization-failed",
    shadowMindEnabled: false,
    sessionId: "session-1",
    error: "Shadow unavailable",
  };
  assert.equal(reducePendingNewSession(failed, { type: "SET_SHADOW", enabled: false }), failed);
  assert.deepEqual(reducePendingNewSession(failed, { type: "SET_SHADOW", enabled: true }), {
    kind: "materialized",
    sessionId: "session-1",
  });
});
