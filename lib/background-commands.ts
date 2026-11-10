import { randomBytes } from "node:crypto";
import { createProjectCommandBashOperations, type ProjectShellSettings } from "./project-command-env";
import type { WakeDelivery, WakeSessionInput } from "./session-wake";
import { BACKGROUND_COMMAND_MESSAGE_TYPE } from "./wake-message-types";
import type { BackgroundCommandDelivery, BackgroundCommandSnapshot } from "./types";

/**
 * Shell commands pi-web runs for a session in the background (the
 * `bash_background` tool). The process belongs to the pi-web process, not to a
 * turn: the turn that started it can end, the page can close. When the command
 * exits, and every `checkInSeconds` while it still runs, the session is woken
 * through lib/session-wake.ts.
 *
 * Commands run through the same shell, environment and command prefix as the
 * bash tool (createProjectCommandBashOperations). They live in memory only: a
 * pi-web restart stops them and forgets them.
 */

export { BACKGROUND_COMMAND_MESSAGE_TYPE };
export const MAX_RUNNING_PER_SESSION = 10;
export const MAX_RUNNING_TOTAL = 30;
export const MIN_CHECK_IN_SECONDS = 60;
export const MAX_CHECK_INS = 12;
const MAX_FINISHED_RECORDS = 30;
const MAX_LOG_CHARS = 256 * 1024;
const MAX_COMMAND_LENGTH = 8_000;
const NOTIFY_TAIL_LINES = 40;
const NOTIFY_TAIL_CHARS = 6_000;

interface CommandRecord {
  snapshot: BackgroundCommandSnapshot;
  lines: string[];
  logChars: number;
  partial: string;
  abort: AbortController;
  checkInTimer: ReturnType<typeof setInterval> | null;
  /** Wakes for this command run one at a time, in order. */
  wakeChain: Promise<void>;
}

declare global {
  var __piWebBackgroundCommands: Map<string, CommandRecord> | undefined;
}

function registry(): Map<string, CommandRecord> {
  if (!globalThis.__piWebBackgroundCommands) {
    globalThis.__piWebBackgroundCommands = new Map();
    process.once("exit", () => {
      for (const record of globalThis.__piWebBackgroundCommands!.values()) record.abort.abort();
    });
  }
  return globalThis.__piWebBackgroundCommands;
}

export function isBackgroundCommandActive(status: BackgroundCommandSnapshot["status"]): boolean {
  return status === "running" || status === "stopping";
}

function appendLine(record: CommandRecord, line: string): void {
  record.lines.push(line);
  record.logChars += line.length + 1;
  while (record.logChars > MAX_LOG_CHARS && record.lines.length > 1) {
    record.logChars -= record.lines.shift()!.length + 1;
  }
}

function appendOutput(record: CommandRecord, chunk: string): void {
  const lines = (record.partial + chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).split(/\r?\n/);
  record.partial = lines.pop() ?? "";
  if (record.partial.length > 8192) {
    lines.push(record.partial);
    record.partial = "";
  }
  for (const line of lines) appendLine(record, line.replace(/\r/g, ""));
}

function pruneFinished(): void {
  const finished = [...registry().entries()]
    .filter(([, record]) => !isBackgroundCommandActive(record.snapshot.status))
    .sort(([, a], [, b]) => (a.snapshot.endedAt ?? 0) - (b.snapshot.endedAt ?? 0));
  for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RECORDS))) registry().delete(id);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function readBackgroundCommandOutput(id: string, options: { lines?: number; search?: string } = {}): string[] | undefined {
  const record = registry().get(id);
  if (!record) return undefined;
  let lines = record.partial ? [...record.lines, record.partial] : [...record.lines];
  if (options.search) {
    const needle = options.search.toLowerCase();
    lines = lines.filter((line) => line.toLowerCase().includes(needle));
  }
  const count = Math.min(Math.max(1, Math.floor(options.lines ?? 100)), 2000);
  return lines.slice(-count);
}

function outputTail(record: CommandRecord, lines: number): string {
  const tail = (readBackgroundCommandOutput(record.snapshot.id, { lines }) ?? []).join("\n");
  const clipped = tail.length > NOTIFY_TAIL_CHARS ? `…${tail.slice(-NOTIFY_TAIL_CHARS)}` : tail;
  return clipped.trim() ? clipped : "(no output)";
}

function title(snapshot: BackgroundCommandSnapshot): string {
  return `Background command [${snapshot.id}]${snapshot.label ? ` "${snapshot.label}"` : ""}`;
}

export function describeBackgroundCommand(snapshot: BackgroundCommandSnapshot, now = Date.now()): string {
  const elapsed = formatDuration((snapshot.endedAt ?? now) - snapshot.startedAt);
  const state = snapshot.status === "running"
    ? `running for ${elapsed}`
    : snapshot.status === "stopping"
      ? "stopping"
      : snapshot.status === "stopped"
        ? `stopped by the ${snapshot.stoppedBy ?? "user"} after ${elapsed}`
        : snapshot.error
          ? `failed to run: ${snapshot.error}`
          : `exited with code ${snapshot.exitCode ?? "unknown"} after ${elapsed}`;
  return `${title(snapshot)} ${state}\n$ ${snapshot.command}`;
}

/** auto: a failure interrupts (steer), a success waits for the current work (followUp). */
export function resolveDelivery(delivery: BackgroundCommandDelivery, snapshot: Pick<BackgroundCommandSnapshot, "status">): WakeDelivery {
  if (delivery !== "auto") return delivery;
  return snapshot.status === "failed" ? "steer" : "followUp";
}

type WakeFn = (input: WakeSessionInput) => Promise<void>;
let wakeOverride: WakeFn | null = null;

/** Tests replace the wake; pi-web loads lib/session-wake.ts (and with it rpc-manager) on first use. */
export function setBackgroundCommandWakeForTests(fn: WakeFn | null): void {
  wakeOverride = fn;
}

async function wakeSession(input: WakeSessionInput): Promise<void> {
  if (wakeOverride) return wakeOverride(input);
  const { wakeSession: wake } = await import("./session-wake");
  return wake(input);
}

function wake(record: CommandRecord, content: string, delivery: WakeDelivery, kind: "exit" | "check-in"): void {
  const { snapshot } = record;
  record.wakeChain = record.wakeChain.then(async () => {
    try {
      await wakeSession({
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        customType: BACKGROUND_COMMAND_MESSAGE_TYPE,
        content,
        details: { commandId: snapshot.id, kind, status: snapshot.status, exitCode: snapshot.exitCode, delivery },
        delivery,
        onLateError: (error) => { snapshot.notifyError = error instanceof Error ? error.message : String(error); },
      });
      snapshot.notifiedAt = Date.now();
      delete snapshot.notifyError;
    } catch (error) {
      snapshot.notifyError = error instanceof Error ? error.message : String(error);
      console.warn("[pi-web] background command wake failed", { commandId: snapshot.id, error: snapshot.notifyError });
    }
  });
}

function checkIn(record: CommandRecord): void {
  const { snapshot } = record;
  if (snapshot.status !== "running") return;
  snapshot.checkIns += 1;
  const last = snapshot.checkIns >= MAX_CHECK_INS;
  if (last && record.checkInTimer) {
    clearInterval(record.checkInTimer);
    record.checkInTimer = null;
  }
  const content = [
    `⏳ ${describeBackgroundCommand(snapshot)}`,
    `It is still running (check-in ${snapshot.checkIns}${last ? ", the last one; you will still be told when it exits" : ""}). Decide whether to keep waiting, read more with bash_background_output, or stop it with bash_background_stop if it looks stuck.`,
    `Last output:\n\`\`\`\n${outputTail(record, 20)}\n\`\`\``,
  ].join("\n\n");
  wake(record, content, "followUp", "check-in");
}

function finish(record: CommandRecord, result: { exitCode: number | null } | { error: string }): void {
  const { snapshot } = record;
  if (!isBackgroundCommandActive(snapshot.status)) return;
  if (record.partial) {
    appendLine(record, record.partial);
    record.partial = "";
  }
  if (record.checkInTimer) clearInterval(record.checkInTimer);
  record.checkInTimer = null;
  snapshot.endedAt = Date.now();
  if (snapshot.status === "stopping" || record.abort.signal.aborted) {
    snapshot.status = "stopped";
  } else if ("error" in result) {
    snapshot.status = "failed";
    snapshot.error = result.error;
  } else {
    snapshot.exitCode = result.exitCode;
    snapshot.status = result.exitCode === 0 ? "exited" : "failed";
  }
  pruneFinished();
  // The agent stopped it itself and already knows.
  if (snapshot.stoppedBy === "agent") return;
  const lead = snapshot.status === "exited" ? "✅" : snapshot.status === "stopped" ? "⏹" : "❌";
  const content = [
    `${lead} ${describeBackgroundCommand(snapshot)}`,
    `Last output:\n\`\`\`\n${outputTail(record, NOTIFY_TAIL_LINES)}\n\`\`\``,
    "Read more with bash_background_output if needed.",
  ].join("\n\n");
  wake(record, content, snapshot.status === "stopped" ? "followUp" : resolveDelivery(snapshot.delivery, snapshot), "exit");
}

export interface StartBackgroundCommandInput {
  sessionId: string;
  cwd: string;
  command: string;
  label?: string;
  checkInSeconds?: number;
  delivery?: BackgroundCommandDelivery;
  shell?: ProjectShellSettings;
}

export function startBackgroundCommand(input: StartBackgroundCommandInput): BackgroundCommandSnapshot {
  const command = input.command.trim();
  if (!command) throw new Error("command is required.");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`command is longer than ${MAX_COMMAND_LENGTH} characters.`);
  const delivery = input.delivery ?? "auto";
  if (!["auto", "followUp", "steer"].includes(delivery)) throw new Error('delivery must be "auto", "followUp" or "steer".');
  let checkInSeconds: number | undefined;
  if (input.checkInSeconds !== undefined) {
    if (!Number.isFinite(input.checkInSeconds) || input.checkInSeconds < MIN_CHECK_IN_SECONDS) {
      throw new Error(`check_in_seconds must be at least ${MIN_CHECK_IN_SECONDS}.`);
    }
    checkInSeconds = Math.round(input.checkInSeconds);
  }
  const running = [...registry().values()].filter((record) => isBackgroundCommandActive(record.snapshot.status));
  if (running.filter((record) => record.snapshot.sessionId === input.sessionId).length >= MAX_RUNNING_PER_SESSION) {
    throw new Error(`This session already runs ${MAX_RUNNING_PER_SESSION} background commands. Stop one first.`);
  }
  if (running.length >= MAX_RUNNING_TOTAL) throw new Error(`pi-web already runs ${MAX_RUNNING_TOTAL} background commands. Stop some first.`);

  const snapshot: BackgroundCommandSnapshot = {
    id: randomBytes(4).toString("hex"),
    sessionId: input.sessionId,
    cwd: input.cwd,
    command,
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 80) } : {}),
    status: "running",
    startedAt: Date.now(),
    delivery,
    ...(checkInSeconds ? { checkInSeconds } : {}),
    checkIns: 0,
  };
  const record: CommandRecord = {
    snapshot,
    lines: [],
    logChars: 0,
    partial: "",
    abort: new AbortController(),
    checkInTimer: null,
    wakeChain: Promise.resolve(),
  };
  registry().set(snapshot.id, record);

  const prefix = input.shell?.getShellCommandPrefix();
  const operations = createProjectCommandBashOperations({ shellPath: input.shell?.getShellPath() });
  const decoder = new TextDecoder();
  operations.exec(prefix ? `${prefix}\n${command}` : command, input.cwd, {
    onData: (data) => appendOutput(record, decoder.decode(data, { stream: true })),
    signal: record.abort.signal,
  }).then(
    (result) => finish(record, { exitCode: result.exitCode }),
    (error: unknown) => finish(record, { error: error instanceof Error ? error.message : String(error) }),
  );
  if (checkInSeconds) {
    record.checkInTimer = setInterval(() => checkIn(record), checkInSeconds * 1000);
    record.checkInTimer.unref?.();
  }
  return { ...snapshot };
}

export function getBackgroundCommand(id: string): BackgroundCommandSnapshot | undefined {
  const record = registry().get(id);
  return record ? { ...record.snapshot } : undefined;
}

export function listBackgroundCommands(filter: { cwd?: string; sessionId?: string } = {}): BackgroundCommandSnapshot[] {
  return [...registry().values()]
    .map((record) => ({ ...record.snapshot }))
    .filter((snapshot) => (filter.cwd === undefined || snapshot.cwd === filter.cwd)
      && (filter.sessionId === undefined || snapshot.sessionId === filter.sessionId))
    .sort((a, b) => Number(isBackgroundCommandActive(b.status)) - Number(isBackgroundCommandActive(a.status)) || b.startedAt - a.startedAt);
}

/** Stop a command and its process tree. The agent's own stop sends no wake; the user's does. */
export function stopBackgroundCommand(id: string, by: "agent" | "user"): BackgroundCommandSnapshot | undefined {
  const record = registry().get(id);
  if (!record) return undefined;
  if (isBackgroundCommandActive(record.snapshot.status)) {
    record.snapshot.status = "stopping";
    record.snapshot.stoppedBy = by;
    record.abort.abort();
  }
  return { ...record.snapshot };
}

export function dismissBackgroundCommand(id: string): boolean {
  const record = registry().get(id);
  if (!record || isBackgroundCommandActive(record.snapshot.status)) return false;
  return registry().delete(id);
}
