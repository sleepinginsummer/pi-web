/** Custom message types pi-web delivers to wake a session (lib/session-wake.ts). */
export const SCHEDULED_TASK_MESSAGE_TYPE = "pi-web:scheduled-task";
export const BACKGROUND_COMMAND_MESSAGE_TYPE = "pi-web:background-command";
export const WAKE_MESSAGE_TYPES: ReadonlySet<string> = new Set([SCHEDULED_TASK_MESSAGE_TYPE, BACKGROUND_COMMAND_MESSAGE_TYPE]);
