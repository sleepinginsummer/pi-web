import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueuedMessage, QueuedMessages } from "./queued-messages";

/**
 * Pi 0.87.0 的公开队列接口只返回文字，peekQueuedMessages 也只预览下一批。
 * 将内部结构依赖隔离在此处：只读真实的两条完整队列，不维护第二份队列，
 * 因而不会把已经 drain、但尚未广播 message_start 的消息错误地移回。
 * SDK 升级必须复核此边界；结构不兼容时在清空前报错，禁止静默丢附件。
 */
export function readAgentMessageQueue(agent: object): QueuedMessages {
  const queues = agent as {
    steeringQueue?: { messages?: AgentMessage[] };
    followUpQueue?: { messages?: AgentMessage[] };
  };
  if (!Array.isArray(queues.steeringQueue?.messages) || !Array.isArray(queues.followUpQueue?.messages)) {
    throw new Error("Pi SDK 队列结构不兼容，无法安全读取或移回附件");
  }
  const project = (messages: AgentMessage[]): QueuedMessage[] => messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return [{
      text: content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
      images: content.filter((block) => block.type === "image").map((block) => ({ data: block.data, mimeType: block.mimeType })),
    }];
  });
  return {
    steering: project(queues.steeringQueue.messages),
    followUp: project(queues.followUpQueue.messages),
  };
}

/** 同步读取再清空，中间不 await，确保移回的是清空时仍待处理的完整消息。 */
export function recallAgentMessageQueue(session: { agent: object; clearQueue(): unknown }): QueuedMessages {
  const queue = readAgentMessageQueue(session.agent);
  session.clearQueue();
  return queue;
}
