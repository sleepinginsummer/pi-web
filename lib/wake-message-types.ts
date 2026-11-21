/** Custom message types pi-web delivers to wake a session (lib/session-wake.ts). */
export const SCHEDULED_TASK_MESSAGE_TYPE = "pi-web:scheduled-task";
export const BACKGROUND_COMMAND_MESSAGE_TYPE = "pi-web:background-command";
export const WAKE_MESSAGE_TYPES: ReadonlySet<string> = new Set([SCHEDULED_TASK_MESSAGE_TYPE, BACKGROUND_COMMAND_MESSAGE_TYPE]);

/**
 * 这个自定义消息是不是「唤醒」消息（后台命令、定时任务）。
 *
 * 唤醒消息会开新的一轮，但不是用户提问：大纲只列用户提问。判定放在这里而不是
 * `lib/session-outline.ts`，因为客户端组件也要用——那边反过来会拖进服务端的会话索引。
 */
export function isWakeMessageType(customType: string | undefined): boolean {
  return Boolean(customType && WAKE_MESSAGE_TYPES.has(customType));
}
