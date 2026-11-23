import type { AgentPhase } from "@/hooks/useAgentSession";

/**
 * The phase a state read (`GET /api/sessions/[id]/state`, `GET /api/agent/[id]`)
 * implies. A tool call the stream already reported running outranks it: the
 * state only says the run is active, and a read landing after `connected` and
 * the replay of the running calls would otherwise say "waiting for model" for
 * the rest of a tool that sends nothing more. `connected` itself starts from no
 * tools, since the replay that follows it lists every call still running.
 */
export function runStatePhase(prev: AgentPhase, isStreaming: boolean): AgentPhase {
  if (prev?.kind === "running_tools" && prev.tools.length > 0) return prev;
  return isStreaming ? { kind: "waiting_model" } : { kind: "running_command" };
}

/** The i18n translate function shape this module needs. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The status line shown while the agent is working.
 *
 * `isCompacting` takes precedence over the phase: auto-compaction can hold a turn for a
 * while before the next token arrives, and reporting the underlying "waiting for model"
 * phase in the meantime reads as a hang. Compaction is what the user needs to know.
 * While compacting, messages queued for after it count beside it (`chat.compactingQueued`).
 *
 * A running tool's newest live output line stands in for the tool names: the tool card
 * above already names the tool and shows its output, so repeating both here only crowds
 * the row.
 *
 * Returns null when there is nothing to report; callers decide whether the status row
 * exists at all (ChatWindow renders it only while a run has no streaming content yet).
 */
export function phaseLabel(
  phase: AgentPhase,
  t: Translate,
  isCompacting?: boolean,
  queuedCount = 0,
  runningCommand?: string | null,
): string | null {
  if (isCompacting) return queuedCount > 0 ? t("chat.compactingQueued", { count: queuedCount }) : t("chat.compacting");
  if (phase?.kind === "running_tools") {
    // Each update moves its tool to the end of the list (running_tools in
    // useAgentSession), so the last entry is the tool that just reported: its live output
    // line is what the user wants to watch, not an older tool's stale one.
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) return latest.progress;
    const names = phase.tools.map((tool) => tool.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return extensionPhaseLabel(t, runningCommand);
  return null;
}

/** A command line can be a whole pasted sentence; the status line shows its beginning. */
export const RUNNING_COMMAND_MAX_CHARS = 120;

export function truncateCommand(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > RUNNING_COMMAND_MAX_CHARS ? `${trimmed.slice(0, RUNNING_COMMAND_MAX_CHARS)}…` : trimmed;
}

/** 扩展命令的状态文案：显示这条命令的提交原文，过长的按字符截断。 */
export function extensionPhaseLabel(t: Translate, runningCommand?: string | null): string {
  return runningCommand ? t("chat.runningExtensionCommand", { command: truncateCommand(runningCommand) }) : t("chat.runningCommand");
}

/** The command name a `/name args` submission addresses, or null when it is not a command. */
export function commandNameOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  return name.length > 0 ? name : null;
}

/**
 * The advice under a running command's status line. pi gives an extension command no abort
 * signal, so Stop cannot end one; the command's own cancel entry is the way out, and the
 * convention (`/review cancel`) is what the extensions follow.
 */
export function phaseHint(phase: AgentPhase, t: Translate, runningCommand?: string | null): string | null {
  if (phase?.kind !== "running_command" || !runningCommand) return null;
  const name = commandNameOf(runningCommand);
  return name ? t("chat.runningExtensionCommandHint", { command: name }) : null;
}
