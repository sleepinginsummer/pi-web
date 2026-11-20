import { hasAssistantFinalAnswer } from "./message-display";
import { normalizeAssistantMessage } from "./normalize";
import type { AssistantMessage, SessionEntry } from "./types";

/**
 * 一条助手记录是否带可展示的最终回答（正文或图片）。
 *
 * 主对话、大纲面板和服务端大纲都用这条规则挑「每轮的最终回答」：末尾只剩
 * 工具调用、思考或空中止时继续往前找，否则这一轮的摘要和标题会被抹掉。
 * 独立成模块是为了让磁盘索引和内存大纲共用同一实现，又不产生循环依赖。
 */
export function hasOutlineFinalAnswer(entry: SessionEntry | null | undefined): boolean {
  if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") return false;
  // 会话文件里的回复正文是块数组；坏记录按「没有回答」处理，不让一条脏数据毁掉整个大纲。
  if (!Array.isArray(entry.message.content)) return false;
  return hasAssistantFinalAnswer(normalizeAssistantMessage(entry.message) as AssistantMessage);
}

/**
 * 从一轮的助手记录里挑最终回答：最后一条有正文/图片的；整轮都没有回答时退回最后一条
 * （摘要为空，和主对话的回退一致）。
 *
 * 与主对话一样不设回退上限：真实回答可能被一长串工具调用或空中止记录隔在前面，设上限
 * 会让大纲把它当成「没有回答」。磁盘大纲只在末尾没有回答时才多读几条记录。
 */
export function pickOutlineFinalAssistant<T>(
  assistants: readonly T[],
  hasAnswer: (assistant: T) => boolean,
): T | null {
  const last = assistants.at(-1);
  if (last === undefined) return null;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    if (hasAnswer(assistants[i])) return assistants[i];
  }
  return last;
}
