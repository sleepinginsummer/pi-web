import type { AgentMessage, AssistantMessage, AssistantContentBlock, TextContent, ThinkingContent, ToolCallContent } from "./types";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
}

/**
 * 兼容部分 provider 将 reasoning 错误作为 <thinking> 文本返回的情况。
 * 只处理文本块开头的完整标签，避免改写普通 Markdown、代码示例或用户内容。
 */
function normalizeThinkingTextBlock(block: unknown): AssistantContentBlock[] | null {
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return null;
  const match = block.text.match(/^\s*<thinking>([\s\S]*?)<\/thinking>([\s\S]*)$/i);
  if (!match || match[1].trim() === "") return null;

  const result: AssistantContentBlock[] = [{ type: "thinking", thinking: match[1].trim() } satisfies ThinkingContent];
  const text = match[2].trim();
  if (text) result.push({ type: "text", text } satisfies TextContent);
  return result;
}

export function normalizeAssistantMessage(msg: AgentMessage): AgentMessage {
  // Non-assistant roles (user, toolResult, bashExecution, custom) are returned
  // unchanged — only assistant messages go through assistant content normalization.
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized: AssistantContentBlock[] = [];
  for (const block of content) {
    const thinking = normalizeThinkingTextBlock(block);
    if (thinking) {
      normalized.push(...thinking);
      continue;
    }
    normalized.push(normalizeToolCallBlock(block) ?? block as AssistantContentBlock);
  }
  return { ...msg, content: normalized } as AgentMessage;
}