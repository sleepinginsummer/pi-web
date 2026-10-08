import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("普通用户 prompt 在扩展抢占空闲边界时按 followUp 排队", async (t) => {
  const submissions = [];
  const inner = {
    sessionId: "shadow-prompt-race",
    sessionManager: SessionManager.inMemory("/tmp"),
    modelRuntime: { getModel: () => undefined },
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    extensionRunner: { getRegisteredCommands: () => [], emit: async () => {} },
    prompt: async (message, options) => {
      assert.equal(inner.isStreaming, true, "扩展已在用户提交的异步准入期间开始运行");
      submissions.push({ message, options });
      options.preflightResult({ disposition: "queued" });
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  // 模拟扩展在用户点击发送后、SDK 收到 prompt 前抢先启动下一轮。
  queueMicrotask(() => { inner.isStreaming = true; });
  await wrapper.send({ type: "prompt", message: "下一条用户消息" });

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].message, "下一条用户消息");
  assert.equal(submissions[0].options.streamingBehavior, "followUp");
  assert.equal(submissions[0].options.source, "rpc");
});
