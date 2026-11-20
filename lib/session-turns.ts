import { getTurnAnchors, type TurnAnchorMessage } from "./message-display";
import type { AgentMessage, SessionEntry } from "./types";

/**
 * entryToUiMessage() 结果里 isMessageGroupAnchor() 会读取的字段，不转换消息正文。
 * 原始 JSON 记录（会话内容索引）与解析后的 SessionEntry 都走这一处，保证轮次划分一致。
 */
export function turnAnchorShape(entry: { type?: unknown; message?: unknown; summary?: unknown; customType?: unknown; display?: unknown }): TurnAnchorMessage | null {
  switch (entry.type) {
    case "message": {
      // 运行时提示词以 system 消息记录，不属于任何一轮。
      const message = entry.message as { role?: AgentMessage["role"] | "system"; stopReason?: unknown } | undefined;
      if (!message?.role || message.role === "system") return null;
      return {
        role: message.role,
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
      };
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

/** 分页在当前页之前的轮次数，连同跨页边界触发新一轮的扩展消息。 */
export function countTurnsBefore<T extends Pick<SessionEntry, "id" | "parentId">>(
  byId: ReadonlyMap<string, T>,
  page: readonly T[],
  shape: (record: T) => TurnAnchorMessage | null,
): number {
  const above: TurnAnchorMessage[] = [];
  let cursor = byId.get(page[0]?.parentId ?? "");
  // 环检测：父链成环（文件被改坏）时不能原地打转。
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const message = shape(cursor);
    if (message) above.push(message);
    cursor = byId.get(cursor.parentId ?? "");
  }
  above.reverse();
  const shown = page.map(shape).filter((message) => message !== null);
  const onBranch = getTurnAnchors([...above, ...shown]);
  const onPage = getTurnAnchors(shown);
  return onBranch.reduce((count, anchor, index) => count + Number(anchor && !onPage[index - above.length]), 0);
}
