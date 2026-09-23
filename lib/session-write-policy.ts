/** 外部写入后仍可执行的只读或中断命令；其余命令可能延续旧 leaf 或写入 JSONL。 */
const SAFE_CONTROL_COMMANDS = new Set([
  "get_state", "get_tools", "get_commands", "get_session_stats", "get_last_assistant_text",
  "abort", "abort_bash", "abort_compaction", "clear_queue",
]);

export function canRunWithExternalSessionChange(commandType: string): boolean {
  return SAFE_CONTROL_COMMANDS.has(commandType);
}
