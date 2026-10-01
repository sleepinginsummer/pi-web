import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readAgentMessageQueue, recallAgentMessageQueue } = await jiti.import("./agent-message-queue.ts");
const { queuedMessagesToDraft, prependChatDraft } = await jiti.import("./queued-messages.ts");
const image = (data = "dGVzdA==") => ({ type: "image", data, mimeType: "image/png" });
const attachment = (data = "dGVzdA==") => ({ data, mimeType: "image/png" });

function setup() {
  const session = Object.create(AgentSession.prototype);
  session.agent = new Agent({ streamFn() { throw new Error("本地队列测试不调用模型"); } });
  session._steeringMessages = [];
  session._followUpMessages = [];
  session._eventListeners = [];
  return session;
}

test("读取当前 SDK 两条完整队列，不受 one-at-a-time 预览限制", async () => {
  const session = setup();
  await session._queueSteer("同一文字", [image()]);
  await session._queueSteer("同一文字", [image("b3RoZXI=")]);
  await session._queueFollowUp("", [image()]);
  assert.equal(session.agent.peekQueuedMessages().length, 1);
  assert.deepEqual(readAgentMessageQueue(session.agent), {
    steering: [
      { text: "同一文字", images: [attachment()] },
      { text: "同一文字", images: [attachment("b3RoZXI=")] },
    ],
    followUp: [{ text: "", images: [attachment()] }],
  });
});

test("移回保留文字与图片，并清空 SDK 真实队列", async () => {
  const session = setup();
  await session._queueSteer("插话", [image()]);
  await session._queueFollowUp("后续", [image("b3RoZXI=")]);
  const recalled = recallAgentMessageQueue(session);
  assert.deepEqual(queuedMessagesToDraft(recalled), {
    value: "插话\n\n后续", images: [attachment(), attachment("b3RoZXI=")],
  });
  assert.equal(session.agent.hasQueuedMessages(), false);
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.deepEqual(session.getFollowUpMessages(), []);
  assert.deepEqual(recallAgentMessageQueue(session), { steering: [], followUp: [] });
});

test("已 drain 但 SDK 文字缓存尚未移除的消息不能被再次移回", async () => {
  const session = setup();
  await session._queueFollowUp("", [image()]);
  await session._queueFollowUp("待处理", [image("b3RoZXI=")]);
  const consumed = session.agent.followUpQueue.drain();
  assert.equal(consumed.length, 1);
  assert.equal(session.getFollowUpMessages().length, 2);
  assert.deepEqual(recallAgentMessageQueue(session), {
    steering: [], followUp: [{ text: "待处理", images: [attachment("b3RoZXI=")] }],
  });
});

test("扩展原生入队的用户图片也保留，非用户消息不混入输入框", () => {
  const session = setup();
  session.agent.followUp({ role: "user", content: [image()], timestamp: 1 });
  session.agent.steer({ role: "custom", customType: "extension", content: "扩展状态", display: false, timestamp: 2 });
  assert.deepEqual(readAgentMessageQueue(session.agent), {
    steering: [], followUp: [{ text: "", images: [attachment()] }],
  });
});

test("SDK 队列结构不兼容时在清空之前报错", () => {
  let cleared = false;
  assert.throws(() => recallAgentMessageQueue({ agent: {}, clearQueue() { cleared = true; } }), /队列结构不兼容/);
  assert.equal(cleared, false);
});

test("恢复草稿保留原输入与附件，不截断多条消息合并后的图片", () => {
  const restored = { value: "排队", images: Array.from({ length: 11 }, () => attachment()) };
  const current = { value: "正在编辑", images: [attachment("b3RoZXI=")], textAttachment: "粘贴文本" };
  const combined = prependChatDraft(restored, current);
  assert.equal(combined.value, "排队\n\n正在编辑");
  assert.equal(combined.images.length, 12);
  assert.equal(combined.textAttachment, "粘贴文本");
  combined.images[0].data = "changed";
  assert.equal(restored.images[0].data, "dGVzdA==");
});

test("RPC 的 SSE、状态快照和移回返回一致的完整队列", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const session = setup();
  const inner = {
    sessionId: "queue-test", sessionFile: undefined,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    autoCompactionEnabled: true, autoRetryEnabled: true,
    modelRuntime: { getModel: () => undefined },
    sessionManager: { getCwd: () => process.cwd() },
    agent: session.agent,
    extensionRunner: { getRegisteredCommands: () => [] },
    subscribe: (listener) => session.subscribe(listener),
    getContextUsage: () => null,
    clearQueue: () => session.clearQueue(),
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  await session._queueFollowUp("检查图片", [image()]);
  await new Promise((resolve) => setImmediate(resolve));
  const expected = { steering: [], followUp: [{ text: "检查图片", images: [attachment()] }] };
  assert.deepEqual(events.filter((event) => event.type === "queue_update").at(-1), { type: "queue_update", ...expected });
  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.queuedMessages, expected);
  assert.equal(state.pendingMessageCount, 1);
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), expected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event.type === "queue_update").at(-1), { type: "queue_update", steering: [], followUp: [] });
});

test("纯图片消息被 drain 后，RPC 队列显示与计数均清空", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const session = setup();
  const inner = {
    sessionId: "image-only-queue-test", sessionFile: undefined,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    modelRuntime: { getModel: () => undefined },
    sessionManager: { getCwd: () => process.cwd() },
    agent: session.agent,
    extensionRunner: { getRegisteredCommands: () => [] },
    subscribe: (listener) => session.subscribe(listener),
    getContextUsage: () => null, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  await session._queueFollowUp("", [image()]);
  const [message] = session.agent.followUpQueue.drain();
  // 使用 SDK 的实际事件广播，模拟 drain 后的用户 message_start。
  session._emit({ type: "message_start", message });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event.type === "queue_update").at(-1), { type: "queue_update", steering: [], followUp: [] });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.pendingMessageCount, 0);
  assert.equal(session.getFollowUpMessages().length, 1);
});
