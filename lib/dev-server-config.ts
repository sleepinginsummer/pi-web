import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Dev servers are declared per project in a launch file, in the same format as
 * Claude Code's `.claude/launch.json`, so one project works in both. pi-web's
 * own `.pi/launch.json` is read first; a name it declares hides the same name
 * in the Claude file.
 */
export const LAUNCH_CONFIG_FILES = [".pi/launch.json", ".claude/launch.json"] as const;
export const DEFAULT_LAUNCH_CONFIG_FILE = LAUNCH_CONFIG_FILES[0];

export interface DevServerConfig {
  name: string;
  /** Omitted when the entry only attaches to a server started elsewhere. */
  runtimeExecutable?: string;
  runtimeArgs: string[];
  port?: number;
  url?: string;
  /** Process working directory, resolved against the project directory. */
  cwd?: string;
  env: Record<string, string>;
  /** Launch file the entry came from, relative to the project directory. */
  source: string;
}

export interface LaunchConfigResult {
  configs: DevServerConfig[];
  errors: string[];
}

const NAME_PATTERN = /^[\w.@:-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePort(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

function parseLocalUrl(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Port a configuration serves on: its own, or the one its url names. */
export function configPort(config: Pick<DevServerConfig, "port" | "url">): number | undefined {
  if (config.port !== undefined) return config.port;
  if (!config.url) return undefined;
  const url = new URL(config.url);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export function configUrl(config: Pick<DevServerConfig, "port" | "url">): string | undefined {
  if (config.url) return config.url;
  return config.port !== undefined ? `http://localhost:${config.port}` : undefined;
}

export function parseLaunchConfig(text: string, source: string): LaunchConfigResult {
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { configs: [], errors: [`${source}: invalid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  if (!isRecord(data) || !Array.isArray(data.configurations)) {
    return { configs: [], errors: [`${source}: expected { "configurations": [...] }`] };
  }
  const configs: DevServerConfig[] = [];
  const names = new Set<string>();
  data.configurations.forEach((entry, index) => {
    const at = `${source} configurations[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${at}: expected an object`);
      return;
    }
    const { name, runtimeExecutable, runtimeArgs, cwd, env } = entry;
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      errors.push(`${at}: "name" must be 1-64 letters, digits or ._@:-`);
      return;
    }
    if (names.has(name)) {
      errors.push(`${at}: duplicate name "${name}"`);
      return;
    }
    const port = parsePort(entry.port);
    const url = parseLocalUrl(entry.url);
    if (port === null) errors.push(`${at}: "port" must be an integer between 1 and 65535`);
    if (url === null) errors.push(`${at}: "url" must be an http(s) URL`);
    if (runtimeExecutable !== undefined && (typeof runtimeExecutable !== "string" || !runtimeExecutable.trim())) {
      errors.push(`${at}: "runtimeExecutable" must be a non-empty string`);
    }
    if (runtimeArgs !== undefined && (!Array.isArray(runtimeArgs) || runtimeArgs.some((arg) => typeof arg !== "string"))) {
      errors.push(`${at}: "runtimeArgs" must be an array of strings`);
    }
    if (cwd !== undefined && typeof cwd !== "string") errors.push(`${at}: "cwd" must be a string`);
    if (env !== undefined && (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string"))) {
      errors.push(`${at}: "env" must map names to strings`);
    }
    if (runtimeExecutable === undefined && url === undefined) {
      errors.push(`${at}: needs "runtimeExecutable" to start a server, or "url" to attach to a running one`);
    }
    if (typeof runtimeExecutable === "string" && port === undefined && url === undefined) {
      errors.push(`${at}: needs "port" so the server's address is known`);
    }
    if (errors.some((error) => error.startsWith(`${at}:`))) return;
    names.add(name);
    configs.push({
      name,
      ...(typeof runtimeExecutable === "string" ? { runtimeExecutable: runtimeExecutable.trim() } : {}),
      runtimeArgs: Array.isArray(runtimeArgs) ? runtimeArgs as string[] : [],
      ...(port !== undefined && port !== null ? { port } : {}),
      ...(url ? { url } : {}),
      ...(typeof cwd === "string" && cwd.trim() ? { cwd: cwd.trim() } : {}),
      env: isRecord(env) ? env as Record<string, string> : {},
      source,
    });
  });
  return { configs, errors };
}

export async function readLaunchConfigs(projectDir: string): Promise<LaunchConfigResult> {
  const configs: DevServerConfig[] = [];
  const errors: string[] = [];
  for (const source of LAUNCH_CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(join(projectDir, source), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseLaunchConfig(text, source);
    errors.push(...parsed.errors);
    for (const config of parsed.configs) {
      if (!configs.some((existing) => existing.name === config.name)) configs.push(config);
    }
  }
  return { configs, errors };
}

/** The directory a configuration's process runs in. */
export function configProcessCwd(projectDir: string, config: Pick<DevServerConfig, "cwd">): string {
  if (!config.cwd) return projectDir;
  return isAbsolute(config.cwd) ? config.cwd : resolve(projectDir, config.cwd);
}

export const LAUNCH_CONFIG_EXAMPLE = `{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "web",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 3000
    }
  ]
}`;
