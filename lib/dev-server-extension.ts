import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LAUNCH_CONFIG_FILE,
  LAUNCH_CONFIG_EXAMPLE,
  LAUNCH_CONFIG_FILES,
  readLaunchConfigs,
} from "./dev-server-config";
import {
  getDevServer,
  listDevServers,
  readDevServerLogs,
  startDevServer,
  stopDevServer,
  type DevServerSnapshot,
} from "./dev-server-manager";

export const HOST_DEV_SERVER_EXTENSION_NAME = "pi-web-dev-servers";
export const DEV_SERVER_TOOL_NAMES = ["server_start", "server_list", "server_logs", "server_stop"] as const;

/** Starting or stopping a process is a shell capability: it follows the session's bash tool. */
const SHELL_TOOL_NAMES = ["bash", "powershell"];

const LAUNCH_FILE_HELP = `Declare servers in ${DEFAULT_LAUNCH_CONFIG_FILE} at the project root (${LAUNCH_CONFIG_FILES[1]} is read too, so a project set up for Claude Code works as is):
${LAUNCH_CONFIG_EXAMPLE}
Each configuration: "name" (unique), "runtimeExecutable" (the command, e.g. npm), "runtimeArgs" (its arguments), "port" (where it listens; PORT is set to it unless "env" sets PORT), optional "cwd" (relative to the project) and "env". An entry with only "name" and "url" attaches to a server already running elsewhere.`;

function text(content: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: content }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

function describe(server: DevServerSnapshot): string {
  const parts = [`${server.name} [${server.id}] ${server.status}`];
  if (server.url) parts.push(server.url);
  if (server.pid) parts.push(`pid ${server.pid}`);
  if (server.exitCode !== undefined && server.exitCode !== null) parts.push(`exit ${server.exitCode}`);
  if (server.error) parts.push(server.error);
  return parts.join(" · ");
}

function tail(id: string, lines: number): string {
  const logs = readDevServerLogs(id, { lines }) ?? [];
  return logs.length === 0 ? "(no output yet)" : logs.map((line) => line.text).join("\n");
}

export function createDevServerExtension(options: {
  cwd: string;
  isEnabled: () => boolean;
}): InlineExtension {
  return {
    name: HOST_DEV_SERVER_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Off in Settings › General: no tools and no prompt text. A reload applies a change.
      if (!options.isEnabled()) return;
      const shellActive = () => pi.getActiveTools().some((name) => SHELL_TOOL_NAMES.includes(name));
      const unavailable = () => !options.isEnabled()
        ? text("Dev servers are turned off in pi-web Settings › General.", true)
        : !shellActive()
          ? text("Starting or stopping servers needs the bash tool, which is not active in this session.", true)
          : undefined;
      const ownServer = (id: string) => {
        const server = getDevServer(id);
        return server && listDevServers(options.cwd).some((item) => item.id === id) ? server : undefined;
      };

      pi.registerTool(defineTool({
        name: "server_start",
        label: "Start server",
        description: `Start a long-running dev server (web app, API, watcher) declared in the project's launch file, by name. pi-web owns the process: it keeps running after this session ends, the user sees it in pi-web's server list and can preview or stop it. Returns once the configured port accepts connections (or after about a minute), with the URL and the latest output. If a server with that name is already running it is reused, not started twice.

${LAUNCH_FILE_HELP}`,
        promptSnippet: "Start a declared dev server that pi-web keeps running and lists for the user",
        promptGuidelines: [
          "Start dev servers and other long-running processes with server_start, never with bash (bash blocks until the command exits and loses background processes).",
          `If the project has no ${DEFAULT_LAUNCH_CONFIG_FILE} entry for the server, create or extend that file first: choose the command from package.json scripts or the framework, and pick a port that is free.`,
          "Use server_logs to check a server's output for errors after changes, and server_stop when it is no longer needed.",
        ],
        parameters: Type.Object({
          name: Type.String({ description: "The configuration name from the launch file." }),
        }),
        async execute(_toolCallId, params) {
          const blocked = unavailable();
          if (blocked) return blocked;
          const { configs, errors } = await readLaunchConfigs(options.cwd);
          const config = configs.find((item) => item.name === params.name);
          if (!config) {
            const known = configs.map((item) => item.name);
            return text([
              `No server named "${params.name}" is declared${known.length ? ` (declared: ${known.join(", ")})` : ""}.`,
              ...errors.map((error) => `Launch file problem: ${error}`),
              LAUNCH_FILE_HELP,
            ].join("\n\n"), true);
          }
          try {
            const { server, reused } = await startDevServer(options.cwd, config);
            const lead = reused
              ? `Already running, reused: ${describe(server)}`
              : server.status === "running"
                ? `Started: ${describe(server)}`
                : server.status === "starting"
                  ? `Started, but port ${server.port} is not accepting connections yet (still building?). Check again with server_list or server_logs: ${describe(server)}`
                  : `The server did not start: ${describe(server)}`;
            const failed = server.status === "failed" || server.status === "exited";
            return text(`${lead}\n\nRecent output:\n${tail(server.id, 30)}`, failed);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "server_list",
        label: "List servers",
        description: "List this project's dev servers that pi-web is running or ran recently, and the names declared in the launch file that are not running.",
        promptSnippet: "List this project's dev servers and their status",
        parameters: Type.Object({}),
        async execute() {
          const servers = listDevServers(options.cwd);
          const { configs, errors } = await readLaunchConfigs(options.cwd);
          const activeNames = new Set(servers
            .filter((server) => ["starting", "running", "stopping"].includes(server.status))
            .map((server) => server.name));
          const idle = configs.filter((config) => !activeNames.has(config.name)).map((config) => config.name);
          return text([
            servers.length ? servers.map(describe).join("\n") : "No servers have been started for this project.",
            idle.length ? `Declared, not running: ${idle.join(", ")}` : "",
            ...errors.map((error) => `Launch file problem: ${error}`),
          ].filter(Boolean).join("\n\n"));
        },
      }));

      pi.registerTool(defineTool({
        name: "server_logs",
        label: "Server logs",
        description: "Read a dev server's recent stdout/stderr, optionally only error lines or lines containing a search string.",
        promptSnippet: "Read a dev server's recent output",
        parameters: Type.Object({
          id: Type.String({ description: "Server id from server_start or server_list." }),
          lines: Type.Optional(Type.Number({ description: "How many of the latest lines to return (default 100, max 2000)." })),
          errors_only: Type.Optional(Type.Boolean({ description: "Only stderr and lines that look like errors." })),
          search: Type.Optional(Type.String({ description: "Only lines containing this text (case-insensitive)." })),
        }),
        async execute(_toolCallId, params) {
          if (!ownServer(params.id)) return text(`No server ${params.id} in this project. Use server_list.`, true);
          const logs = readDevServerLogs(params.id, {
            lines: params.lines,
            errorsOnly: params.errors_only,
            search: params.search,
          }) ?? [];
          return text(logs.length ? logs.map((line) => line.text).join("\n") : "(no matching output)");
        },
      }));

      pi.registerTool(defineTool({
        name: "server_stop",
        label: "Stop server",
        description: "Stop a dev server and its child processes.",
        promptSnippet: "Stop a dev server",
        parameters: Type.Object({
          id: Type.String({ description: "Server id from server_start or server_list." }),
        }),
        async execute(_toolCallId, params) {
          const blocked = unavailable();
          if (blocked) return blocked;
          if (!ownServer(params.id)) return text(`No server ${params.id} in this project. Use server_list.`, true);
          const server = await stopDevServer(params.id);
          return text(server ? describe(server) : `No server ${params.id}.`);
        },
      }));
    },
  };
}
