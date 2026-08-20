import { getImageSource } from "./image-content";
import type { AssistantContentBlock, AssistantMessage, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isDisplayableAssistantBlock(
  block: AssistantContentBlock,
  options: DisplayOptions = {},
): boolean {
  if (block.type === "text") return options.isStreaming || block.text.trim() !== "";
  if (block.type === "thinking") {
    return Boolean(block.deferred) || Boolean(options.isStreaming) || block.thinking.trim() !== "";
  }
  if (block.type === "image") return getImageSource(block) !== "";
  // todo 调用由 TodoListPanel 汇总展示，消息正文不再重复渲染。
  if (block.type === "toolCall") return block.toolName !== "todo";
  return true;
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => isDisplayableAssistantBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
