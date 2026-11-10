import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  describeBackgroundCommand,
  getBackgroundCommand,
  listBackgroundCommands,
  MIN_CHECK_IN_SECONDS,
  readBackgroundCommandOutput,
  startBackgroundCommand,
  stopBackgroundCommand,
} from "./background-commands";
import type { ProjectShellSettings } from "./project-command-env";

export const HOST_BACKGROUND_COMMAND_EXTENSION_NAME = "pi-web-background-commands";
export const BACKGROUND_COMMAND_TOOL_NAMES = ["bash_background", "bash_background_output", "bash_background_stop"] as const;

/** Running a command is a shell capability: it follows the session's bash tool, like server_start. */
const SHELL_TOOL_NAMES = ["bash", "powershell"];

function text(content: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: content }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

export function createBackgroundCommandExtension(options: {
  cwd: string;
  isEnabled: () => boolean;
  shell?: ProjectShellSettings;
}): InlineExtension {
  return {
    name: HOST_BACKGROUND_COMMAND_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Off in Settings › General: no tools and no prompt text. A reload applies a change.
      if (!options.isEnabled()) return;
      const shellActive = () => pi.getActiveTools().some((name) => SHELL_TOOL_NAMES.includes(name));
      const unavailable = () => !options.isEnabled()
        ? text("Background commands are turned off in pi-web Settings › General.", true)
        : !shellActive()
          ? text("Background commands need the bash tool, which is not active in this session.", true)
          : undefined;
      const own = (id: string, sessionId: string) => {
        const command = getBackgroundCommand(id);
        return command?.sessionId === sessionId ? command : undefined;
      };

      pi.registerTool(defineTool({
        name: "bash_background",
        label: "Run in background",
        description: `Run a shell command in the background and get woken when it finishes. The tool returns at once with an id; pi-web owns the process, so your turn can end (or you can keep working) and the page can close. When the command exits, this session receives its exit code and last lines of output as a new message. Use it for slow, finite work whose result you need: test suites, builds, installs, migrations, long scripts. For servers that keep running, use server_start instead.

Optional check_in_seconds (at least ${MIN_CHECK_IN_SECONDS}) also wakes you at that interval while the command is still running, with its latest output, so a hung command does not go unnoticed.

delivery decides how the result reaches you if you are busy at that moment: "auto" (default) interrupts after your current tool calls when the command failed and waits until you finish your current work when it succeeded; "steer" always interrupts; "followUp" always waits. An idle session starts a new turn either way.`,
        promptSnippet: "Run a slow shell command in the background and get woken when it exits",
        promptGuidelines: [
          "For commands that take more than a minute or two (full test suites, builds, installs), use bash_background instead of bash, then end your turn or continue with independent work; you will be woken with the result.",
          "Do not poll bash_background_output in a loop or sleep while waiting; the exit message arrives on its own.",
          "Set check_in_seconds for commands that might hang.",
        ],
        parameters: Type.Object({
          command: Type.String({ description: "The shell command, run like the bash tool in the project directory." }),
          label: Type.Optional(Type.String({ description: "Short name shown in pi-web's list, e.g. \"unit tests\"." })),
          check_in_seconds: Type.Optional(Type.Number({ description: `Also wake this session at this interval while the command runs (at least ${MIN_CHECK_IN_SECONDS}).` })),
          delivery: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("followUp"), Type.Literal("steer")], {
            description: '"auto" (default): steer on failure, followUp on success.',
          })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const blocked = unavailable();
          if (blocked) return blocked;
          try {
            const command = startBackgroundCommand({
              sessionId: ctx.sessionManager.getSessionId(),
              cwd: options.cwd,
              command: params.command,
              label: params.label,
              checkInSeconds: params.check_in_seconds,
              delivery: params.delivery,
              shell: options.shell,
            });
            return text(`Started in the background: [${command.id}]${command.label ? ` "${command.label}"` : ""}. You will be woken when it exits${command.checkInSeconds ? ` and every ${command.checkInSeconds}s while it runs` : ""}. Do not wait or poll for it.`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "bash_background_output",
        label: "Background output",
        description: "Read a background command's status and recent output. Without an id, list this session's background commands.",
        promptSnippet: "Read a background command's output, or list them",
        parameters: Type.Object({
          id: Type.Optional(Type.String({ description: "Command id from bash_background." })),
          lines: Type.Optional(Type.Number({ description: "How many of the latest lines to return (default 100, max 2000)." })),
          search: Type.Optional(Type.String({ description: "Only lines containing this text (case-insensitive)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const sessionId = ctx.sessionManager.getSessionId();
          if (!params.id) {
            const commands = listBackgroundCommands({ sessionId });
            return text(commands.length ? commands.map((command) => describeBackgroundCommand(command)).join("\n\n") : "This session has no background commands.");
          }
          const command = own(params.id, sessionId);
          if (!command) return text(`No background command ${params.id} in this session.`, true);
          const output = readBackgroundCommandOutput(command.id, { lines: params.lines, search: params.search }) ?? [];
          return text(`${describeBackgroundCommand(command)}\n\n${output.length ? output.join("\n") : "(no matching output)"}`);
        },
      }));

      pi.registerTool(defineTool({
        name: "bash_background_stop",
        label: "Stop background command",
        description: "Stop a background command and its child processes. You are not woken for a command you stop yourself.",
        promptSnippet: "Stop a background command",
        parameters: Type.Object({
          id: Type.String({ description: "Command id from bash_background." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          if (!own(params.id, ctx.sessionManager.getSessionId())) return text(`No background command ${params.id} in this session.`, true);
          const command = stopBackgroundCommand(params.id, "agent");
          return text(command ? `Stopping [${command.id}].` : `No background command ${params.id}.`);
        },
      }));
    },
  };
}
