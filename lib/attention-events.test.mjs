import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAttentionSession,
  publishAttentionEvent,
  subscribeAttentionEvents,
} from "./attention-events.ts";

function selectRequest(id, title = "普通选择") {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options: ["是", "否"],
  };
}

test("会话级启发式会持续到所有并发 ask 结束，并明确抑制期间的普通 select", () => {
  const sessionId = `attention-concurrent-${Date.now()}`;
  const events = [];
  const unsubscribe = subscribeAttentionEvents((event) => events.push(event));
  try {
    publishAttentionEvent(sessionId, { type: "tool_execution_start", toolName: "ask_user_question", toolCallId: "ask-1", args: {} });
    publishAttentionEvent(sessionId, { type: "tool_execution_start", toolName: "ask_user_question", toolCallId: "ask-2", args: {} });
    publishAttentionEvent(sessionId, { type: "tool_execution_end", toolName: "ask_user_question", toolCallId: "ask-1" });
    publishAttentionEvent(sessionId, selectRequest("unrelated-dialog-while-ask-active"));
    assert.deepEqual(events.map((event) => event.kind), ["ask", "ask"]);

    publishAttentionEvent(sessionId, { type: "tool_execution_end", toolName: "ask_user_question", toolCallId: "ask-2" });
    publishAttentionEvent(sessionId, selectRequest("ordinary-dialog"));
    assert.deepEqual(events.map((event) => event.kind), ["ask", "ask", "dialog"]);
  } finally {
    clearAttentionSession(sessionId);
    unsubscribe();
  }
});

test("会话 abort 或异常销毁清理后，普通 dialog 不会被历史 ask 误抑制", () => {
  const sessionId = `attention-abort-${Date.now()}`;
  const events = [];
  const unsubscribe = subscribeAttentionEvents((event) => events.push(event));
  try {
    publishAttentionEvent(sessionId, { type: "tool_execution_start", toolName: "ask_user_question", toolCallId: "stale-ask", args: {} });
    clearAttentionSession(sessionId);
    publishAttentionEvent(sessionId, selectRequest("dialog-after-abort"));
    assert.deepEqual(events.map((event) => event.kind), ["ask", "dialog"]);
  } finally {
    clearAttentionSession(sessionId);
    unsubscribe();
  }
});

test("监听器异常不会打断发布或阻止后续监听器", () => {
  const sessionId = `attention-listener-error-${Date.now()}`;
  const received = [];
  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);
  const unsubscribeFailing = subscribeAttentionEvents(() => {
    throw new Error("listener failed");
  });
  const unsubscribeHealthy = subscribeAttentionEvents((event) => received.push(event));
  try {
    assert.doesNotThrow(() => publishAttentionEvent(sessionId, selectRequest("dialog-after-error")));
    assert.deepEqual(received.map((event) => event.kind), ["dialog"]);
    assert.equal(loggedErrors.length, 1);
    assert.match(String(loggedErrors[0][0]), /监听器执行失败/);
  } finally {
    console.error = originalConsoleError;
    unsubscribeFailing();
    unsubscribeHealthy();
    clearAttentionSession(sessionId);
  }
});
