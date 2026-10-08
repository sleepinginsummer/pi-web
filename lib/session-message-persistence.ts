import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * SDK 保存工具结果时保留原对象；扩展可能在后续批次失败时修改它的嵌套字段。
 * 在持久化入口按 JSONL 的序列化规则建立独立快照，避免插件改动连带修改历史。
 * 每个新建或重开的可写 manager 只在交给 AgentSession 前安装一次。
 */
export function isolateToolResultPersistence(manager: Pick<SessionManager, "appendMessage">): void {
  const appendMessage = manager.appendMessage.bind(manager);
  manager.appendMessage = (message) => appendMessage(
    message.role === "toolResult" ? JSON.parse(JSON.stringify(message)) : message,
  );
}
