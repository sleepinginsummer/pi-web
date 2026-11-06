import type { SessionManager } from "@earendil-works/pi-coding-agent";

type PersistedAppends = Pick<SessionManager, "appendMessage" | "appendCustomEntry" | "appendCustomMessageEntry">;

/** 按 JSONL 的序列化规则建立独立快照：内存里保存的就是写进磁盘的那一份。 */
function snapshot<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * SDK 保存 entry 时直接引用调用方传入的对象，而扩展可能在保存之后继续修改它：
 * - hashline 批次失败时回头修改已返回工具结果的嵌套 details；
 * - pi-goal 的 goal-state 保存的是活动 goal 对象本身，之后每轮原地累加用量和时间。
 * 结果是内存历史跟着变，磁盘仍是保存时的值，磁盘核对把它判成外部修改（409）。
 * 在持久化入口建立独立快照，避免插件改动连带修改历史。
 * 每个新建或重开的可写 manager 只在交给 AgentSession 前安装一次。
 */
export function isolateSessionEntryPersistence(manager: PersistedAppends): void {
  const appendMessage = manager.appendMessage.bind(manager);
  manager.appendMessage = (message) => appendMessage(
    message.role === "toolResult" ? snapshot(message) : message,
  );

  const appendCustomEntry = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (customType, data) => appendCustomEntry(customType, snapshot(data));

  const appendCustomMessageEntry = manager.appendCustomMessageEntry.bind(manager);
  manager.appendCustomMessageEntry = (customType, content, display, details) => appendCustomMessageEntry(
    customType,
    snapshot(content),
    display,
    snapshot(details),
  );
}
