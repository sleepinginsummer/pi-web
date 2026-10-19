import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import {
  configPort,
  configProcessCwd,
  configUrl,
  type DevServerConfig,
} from "./dev-server-config";
import { samePath } from "./paths";
import { sanitizeProjectCommandEnvironment } from "./project-command-env";
import type { DevServerLogLine, DevServerSnapshot, DevServerStatus } from "./types";

/**
 * Dev servers started for a project are owned by the pi-web server process,
 * not by an agent session: a session can be disposed after its idle timeout
 * while the server it started keeps running for the panel and later sessions.
 */

export type { DevServerLogLine, DevServerSnapshot, DevServerStatus };

interface DevServerRecord {
  snapshot: DevServerSnapshot;
  child?: ChildProcess;
  logs: DevServerLogLine[];
  logChars: number;
  partial: { stdout: string; stderr: string };
  stopRequested: boolean;
  ready?: Promise<void>;
}

declare global {
  var __piWebDevServers: Map<string, DevServerRecord> | undefined;
}

const MAX_LOG_CHARS = 256 * 1024;
const MAX_FINISHED_RECORDS = 20;
const STOP_GRACE_MS = 5000;
export const DEV_SERVER_READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 300;

function registry(): Map<string, DevServerRecord> {
  if (!globalThis.__piWebDevServers) {
    globalThis.__piWebDevServers = new Map();
    const shutdown = () => {
      for (const record of globalThis.__piWebDevServers!.values()) killProcessTree(record, "SIGKILL");
    };
    process.once("exit", shutdown);
  }
  return globalThis.__piWebDevServers;
}

function isActive(status: DevServerStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

function snapshotOf(record: DevServerRecord): DevServerSnapshot {
  return { ...record.snapshot };
}

function appendLog(record: DevServerRecord, stream: DevServerLogLine["stream"], text: string): void {
  record.logs.push({ stream, text, time: Date.now() });
  record.logChars += text.length;
  while (record.logChars > MAX_LOG_CHARS && record.logs.length > 1) {
    record.logChars -= record.logs.shift()!.text.length;
  }
}

function appendOutput(record: DevServerRecord, stream: "stdout" | "stderr", chunk: string): void {
  const lines = (record.partial[stream] + chunk).split(/\r?\n/);
  record.partial[stream] = lines.pop() ?? "";
  // A process that never prints a newline still gets bounded memory.
  if (record.partial[stream].length > 8192) {
    lines.push(record.partial[stream]);
    record.partial[stream] = "";
  }
  for (const line of lines) appendLog(record, stream, line);
}

function flushOutput(record: DevServerRecord): void {
  for (const stream of ["stdout", "stderr"] as const) {
    if (record.partial[stream]) appendLog(record, stream, record.partial[stream]);
    record.partial[stream] = "";
  }
}

function killProcessTree(record: DevServerRecord, signal: NodeJS.Signals): void {
  const pid = record.child?.pid;
  if (!pid || record.child?.exitCode !== null || record.child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // The server was spawned as its own process group: `npm run dev` exits
      // on SIGTERM while its child keeps the port unless the group is signalled.
      process.kill(-pid, signal);
    }
  } catch {
    try { record.child?.kill(signal); } catch { /* already gone */ }
  }
}

function pruneFinished(): void {
  const finished = [...registry().entries()]
    .filter(([, record]) => !isActive(record.snapshot.status))
    .sort(([, a], [, b]) => (a.snapshot.endedAt ?? 0) - (b.snapshot.endedAt ?? 0));
  for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RECORDS))) {
    registry().delete(id);
  }
}

export function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  const attempt = (host: string) => new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  // Dev servers bind either loopback family depending on the tool and Node version.
  return attempt("127.0.0.1").then((open) => open || attempt("::1"));
}

function findActive(projectCwd: string, name: string): DevServerRecord | undefined {
  return [...registry().values()].find((record) => (
    record.snapshot.name === name
    && samePath(record.snapshot.projectCwd, projectCwd)
    && isActive(record.snapshot.status)
  ));
}

function findActiveOnPort(port: number): DevServerRecord | undefined {
  return [...registry().values()].find((record) => record.snapshot.port === port && isActive(record.snapshot.status));
}

export function listDevServers(projectCwd?: string): DevServerSnapshot[] {
  return [...registry().values()]
    .filter((record) => !projectCwd || samePath(record.snapshot.projectCwd, projectCwd))
    .map(snapshotOf)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getDevServer(id: string): DevServerSnapshot | undefined {
  const record = registry().get(id);
  return record ? snapshotOf(record) : undefined;
}

export interface DevServerLogQuery {
  lines?: number;
  /** Only stderr and lines that look like errors. */
  errorsOnly?: boolean;
  search?: string;
}

const ERROR_LINE = /\b(error|exception|failed|fatal|unhandled|panic)\b/i;

export function readDevServerLogs(id: string, query: DevServerLogQuery = {}): DevServerLogLine[] | undefined {
  const record = registry().get(id);
  if (!record) return undefined;
  const limit = Math.min(Math.max(Math.floor(query.lines ?? 100), 1), 2000);
  const search = query.search?.toLowerCase();
  const pending = (["stdout", "stderr"] as const)
    .filter((stream) => record.partial[stream])
    .map((stream) => ({ stream, text: record.partial[stream], time: Date.now() }));
  return [...record.logs, ...pending]
    .filter((line) => !query.errorsOnly || (line.stream === "system"
      // pi-web's own notes echo the command, which may contain these words.
      ? line.text.startsWith("Failed to start")
      : line.stream === "stderr" || ERROR_LINE.test(line.text)))
    .filter((line) => !search || line.text.toLowerCase().includes(search))
    .slice(-limit);
}

export interface StartDevServerResult {
  server: DevServerSnapshot;
  /** True when an already-running server was returned instead of a new one. */
  reused: boolean;
}

export interface StartDevServerOptions {
  readyTimeoutMs?: number;
  /** Environment the server inherits before pi-web's own variables are removed. */
  baseEnvironment?: NodeJS.ProcessEnv;
}

async function waitUntilReady(record: DevServerRecord, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (record.snapshot.status === "starting") {
    if (await isPortOpen(port)) {
      if (record.snapshot.status === "starting") {
        record.snapshot.status = "running";
        appendLog(record, "system", `Listening on port ${port}`);
      }
      return;
    }
    if (Date.now() >= deadline) {
      // The process is left running: slow first builds are common, and the
      // panel keeps watching it. The caller learns it is not ready yet.
      appendLog(record, "system", `Port ${port} did not open within ${Math.round(timeoutMs / 1000)}s`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

/** Promotes a server whose port opened after the start call gave up waiting. */
async function watchLateReadiness(record: DevServerRecord, port: number): Promise<void> {
  while (record.snapshot.status === "starting") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (record.snapshot.status === "starting" && await isPortOpen(port)) {
      record.snapshot.status = "running";
      appendLog(record, "system", `Listening on port ${port}`);
    }
  }
}

export async function startDevServer(
  projectCwd: string,
  config: DevServerConfig,
  options: StartDevServerOptions = {},
): Promise<StartDevServerResult> {
  const existing = findActive(projectCwd, config.name);
  if (existing) {
    await existing.ready;
    return { server: snapshotOf(existing), reused: true };
  }
  const port = configPort(config);
  const url = configUrl(config);
  const cwd = configProcessCwd(projectCwd, config);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const base: DevServerSnapshot = {
    id,
    name: config.name,
    projectCwd,
    cwd,
    status: "starting",
    managed: Boolean(config.runtimeExecutable),
    ...(port !== undefined ? { port } : {}),
    ...(url ? { url } : {}),
    startedAt: Date.now(),
  };

  if (port !== undefined) {
    const owner = findActiveOnPort(port);
    if (owner) {
      throw new Error(`Port ${port} is already used by dev server "${owner.snapshot.name}" (${owner.snapshot.projectCwd})`);
    }
  }

  if (!config.runtimeExecutable) {
    // Attach-only entry: the server was started elsewhere, pi-web only lists it.
    if (port === undefined || !await isPortOpen(port)) {
      throw new Error(`Nothing is listening at ${url ?? "the configured url"}; start that server first or add "runtimeExecutable" to launch it`);
    }
    const record: DevServerRecord = {
      snapshot: { ...base, status: "running" },
      logs: [],
      logChars: 0,
      partial: { stdout: "", stderr: "" },
      stopRequested: false,
    };
    appendLog(record, "system", `Attached to ${url}; pi-web does not own this process and cannot show its output`);
    registry().set(id, record);
    pruneFinished();
    return { server: snapshotOf(record), reused: false };
  }

  if (port !== undefined && await isPortOpen(port)) {
    throw new Error(`Port ${port} is already in use by another process. Stop it, choose another port, or declare an entry with only "url" to attach to it`);
  }

  const environment = sanitizeProjectCommandEnvironment(options.baseEnvironment ?? process.env);
  for (const [key, value] of Object.entries(config.env)) environment[key] = value;
  if (port !== undefined && environment.PORT === undefined) environment.PORT = String(port);
  environment.FORCE_COLOR ??= "0";

  const command = [config.runtimeExecutable, ...config.runtimeArgs].join(" ");
  const record: DevServerRecord = {
    snapshot: { ...base, command },
    logs: [],
    logChars: 0,
    partial: { stdout: "", stderr: "" },
    stopRequested: false,
  };
  registry().set(id, record);
  appendLog(record, "system", `$ ${command}  (cwd ${cwd})`);

  const child = spawn(config.runtimeExecutable, config.runtimeArgs, {
    cwd,
    env: environment,
    detached: process.platform !== "win32",
    // npm, pnpm and friends are .cmd shims on Windows.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  record.child = child;
  record.snapshot.pid = child.pid;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendOutput(record, "stdout", chunk));
  child.stderr?.on("data", (chunk: string) => appendOutput(record, "stderr", chunk));

  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      record.snapshot.status = "failed";
      record.snapshot.error = error.message;
      record.snapshot.endedAt = Date.now();
      appendLog(record, "system", `Failed to start: ${error.message}`);
      resolve();
    });
    child.once("exit", (code, signal) => {
      flushOutput(record);
      record.snapshot.exitCode = code;
      record.snapshot.signal = signal;
      record.snapshot.endedAt = Date.now();
      if (record.snapshot.status !== "failed") {
        record.snapshot.status = record.stopRequested
          ? "stopped"
          : code === 0 ? "exited" : "failed";
      }
      appendLog(record, "system", `Process exited (${signal ?? `code ${code}`})`);
      pruneFinished();
      resolve();
    });
  });

  const readyTimeoutMs = options.readyTimeoutMs ?? DEV_SERVER_READY_TIMEOUT_MS;
  record.ready = port === undefined
    ? Promise.resolve().then(() => {
        if (record.snapshot.status === "starting") record.snapshot.status = "running";
      })
    : Promise.race([waitUntilReady(record, port, readyTimeoutMs), exited]);
  await record.ready;
  if (record.snapshot.status === "starting" && port !== undefined) void watchLateReadiness(record, port);
  return { server: snapshotOf(record), reused: false };
}

export async function stopDevServer(id: string): Promise<DevServerSnapshot | undefined> {
  const record = registry().get(id);
  if (!record) return undefined;
  if (!isActive(record.snapshot.status) || record.snapshot.status === "stopping") return snapshotOf(record);
  record.stopRequested = true;
  if (!record.child) {
    // Attached entries are only forgotten; the process belongs to someone else.
    record.snapshot.status = "stopped";
    record.snapshot.endedAt = Date.now();
    appendLog(record, "system", "Detached");
    return snapshotOf(record);
  }
  record.snapshot.status = "stopping";
  const exited = new Promise<void>((resolve) => {
    if (record.child!.exitCode !== null || record.child!.signalCode !== null) resolve();
    else record.child!.once("exit", () => resolve());
  });
  killProcessTree(record, "SIGTERM");
  const timer = setTimeout(() => killProcessTree(record, "SIGKILL"), STOP_GRACE_MS);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
  return snapshotOf(record);
}

/** Removes a finished entry from the list. Running servers must be stopped first. */
export function dismissDevServer(id: string): boolean {
  const record = registry().get(id);
  if (!record || isActive(record.snapshot.status)) return false;
  return registry().delete(id);
}

export function stopAllDevServersForTests(): void {
  for (const record of registry().values()) killProcessTree(record, "SIGKILL");
  registry().clear();
}
