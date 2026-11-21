import { BACKGROUND_COMMAND_MESSAGE_TYPE, SCHEDULED_TASK_MESSAGE_TYPE } from "./wake-message-types";

/**
 * 唤醒消息（后台命令、定时任务）在大纲、索引里显示的名字。
 *
 * 这些消息的正文是给模型看的：命令标题、`$` 命令行、输出尾巴，或者任务名加整段提示词。
 * 大纲一行只有一两行的宽度，直接铺正文看不清也认不出是哪一个 —— 这里取出列表里用的那个
 * 标题（后台命令的 `label`，没有 label 就用命令行首行；定时任务用任务名）。
 */

/** `Background command [<id>] "<label>" exited …`：label 可能没有。 */
const BACKGROUND_HEAD = /^Background command\s*\[[^\]]*\]\s*(?:"([^"]*)")?/;
/** 唤醒消息里 `$ <command>` 那一行。 */
const BACKGROUND_COMMAND_LINE = /^\$\s+(\S.*)$/m;
/** `⏰ Scheduled task "<name>" [<id>] fired …`（名称里可能有引号，取第一个成对的 "…"）。 */
const SCHEDULED_HEAD = /Scheduled task\s+"([^"]+)"/;

export function wakeMessageTitle(customType: string | undefined, text: string): string | null {
  if (!customType || !text) return null;
  if (customType === BACKGROUND_COMMAND_MESSAGE_TYPE) {
    const label = text.match(BACKGROUND_HEAD)?.[1]?.trim();
    if (label) return label;
    const command = text.match(BACKGROUND_COMMAND_LINE)?.[1]?.trim();
    if (command) return command;
    return null;
  }
  if (customType === SCHEDULED_TASK_MESSAGE_TYPE) {
    return text.match(SCHEDULED_HEAD)?.[1]?.trim() || null;
  }
  return null;
}
