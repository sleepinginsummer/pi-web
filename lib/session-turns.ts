import { isMessageGroupAnchor } from "./message-display";
import type { AgentMessage, SessionEntry } from "./types";

/**
 * entryToUiMessage() 结果里 isMessageGroupAnchor() 会读取的字段，不转换消息正文。
 * 原始 JSON 记录（会话内容索引）与解析后的 SessionEntry 都走这一处，保证轮次划分一致。
 */
function turnAnchorShape(entry: { type?: unknown; message?: unknown; summary?: unknown; customType?: unknown; display?: unknown }): Parameters<typeof isMessageGroupAnchor>[0] | null {
  switch (entry.type) {
    case "message": {
      // 运行时提示词以 system 消息记录，不属于任何一轮。
      const message = entry.message as { role?: string } | undefined;
      return !message || message.role === "system" ? null : message as AgentMessage;
    }
    case "compaction":
      return { role: "custom", customType: "compaction", display: true };
    case "branch_summary":
      return entry.summary ? { role: "user" } : null;
    case "custom_message":
      return {
        role: "custom",
        customType: typeof entry.customType === "string" ? entry.customType : undefined,
        display: entry.display === true,
      };
    default:
      return null;
  }
}

/** 这条记录在聊天里是否开启新的一轮（与 ChatWindow 分组和 minimap 编号相同的规则）。 */
export function isTurnAnchorEntry(entry: { type?: unknown; message?: unknown; summary?: unknown; customType?: unknown; display?: unknown }): boolean {
  const shape = turnAnchorShape(entry);
  return shape !== null && isMessageGroupAnchor(shape);
}

/**
 * 分页最旧一条之上的轮次数（#791）：minimap 以此为起点编号，加载更早的页时编号不变。
 */
export function countTurnsBefore(entries: SessionEntry[], oldest: SessionEntry): number {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  let turns = 0;
  let current = oldest.parentId ? byId.get(oldest.parentId) : undefined;
  while (current) {
    if (isTurnAnchorEntry(current)) turns++;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return turns;
}
