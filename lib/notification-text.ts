import { splitFinalAssistantBlocks } from "./message-display";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "./types";

export const NOTIFICATION_TITLE_CHARS = 48;
export const NOTIFICATION_PREVIEW_CHARS = 80;

export function compactNotificationText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

/** 通知只显示纯文本：去掉标记、保留文字；下划线强调不处理，避免破坏 snake_case。 */
export function stripNotificationMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*(?:```|~~~).*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+/g, "")
    .replace(/\*\*|~~/g, "")
    .replace(/(^|[\s(（])\*(?=\S)([^*\n]*\S)\*/g, "$1$2");
}

/** 取最后一条有正文的助手回复，生成通知预览；没有正文时返回空串。 */
export function getAssistantNotificationPreview(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks
      .filter((block): block is Extract<AssistantContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const preview = compactNotificationText(stripNotificationMarkdown(text), NOTIFICATION_PREVIEW_CHARS);
    if (preview) return preview;
  }
  return "";
}
