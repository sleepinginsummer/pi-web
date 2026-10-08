import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentRuntimeSnapshot, AgentRuntimeState } from "./agent-state";
import { validateAgentImages } from "./image-attachments";
import { readAgentMessageQueue, recallAgentMessageQueue } from "./agent-message-queue";
import { expandMultiSkillCommand } from "./multi-skill-command";
import { invalidateModelsCache, updateCachedDefaultModel } from "./models-cache";
import { PendingPromptTracker } from "./pending-prompt-tracker";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, getLatestModelChange, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { SessionDiskInspector, type SessionDiskFreshness } from "./session-disk-freshness";
import { isolateToolResultPersistence } from "./session-message-persistence";
import { canRunWithExternalSessionChange } from "./session-write-policy";
import { restoreShadowSessionSettingSafely, ShadowSessionSetting } from "./shadow-session-setting";
import { parseShadowMindToggleCommand, SHADOW_MIND_SESSION_STATE } from "./shadow-session-protocol";
import { createClonedSession, createForkedSession } from "./session-fork";
import { generateTitleForSessionFile } from "./session-file-title";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import { hasActiveSessionLivenessProvider } from "./session-liveness";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import { clearAttentionSession, publishAttentionEvent } from "./attention-events";
import { FastSessionSetting, FAST_SESSION_STATE, type FastRuntimeSnapshot } from "./fast-session-setting";
import { readModelsConfigSnapshot } from "./models-config-commit";
import { createSubagentExtension, preferPiWebSubagentExtension } from "./subagent-extension";
import {
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  subagentExtensionLoaderOptions,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./subagents";
import { createSubagentController } from "./subagent-runtime";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { resolveShellTools } from "./powershell-settings";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS, contextFilesSystemPrompt } from "./chat-only";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import { createPiWebBuiltinExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { mcpPromptPreparation, type McpCommandCandidate } from "./mcp-command";
import { createReadOnlyMcpPolicyExtension } from "./mcp-read-only-policy";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { isNestedToolExecutionEvent } from "./agent-event-wire";
import {
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type ShadowSettingCommandResult = {
  kind: "shadow-setting";
  enabled: boolean;
};

export function isShadowSettingCommandResult(value: unknown): value is ShadowSettingCommandResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; enabled?: unknown };
  return candidate.kind === "shadow-setting" && typeof candidate.enabled === "boolean";
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

type AgentSessionWrapperOptions = {
  persistedSessionFile?: boolean;
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
  suppressCompletionNotifications?: boolean;
  /** Connects the session's MCP servers before a prompt starts a run, and lets go of them when it closes (lib/mcp-host.ts). */
  mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);
export const MCP_WAIT_STOPPED_MESSAGE = "Stopped while MCP servers were connecting; the message was not sent.";

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 解析会话空闲超时；0 表示禁用，非法值回退到 10 分钟。 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Resolves the PI_WEB_SHUTDOWN_DEADLINE_MS environment variable into the time
 * extensions get to handle `session_shutdown` before the wrapper disposes the
 * SDK session anyway. An unset/blank value returns the 5-second default, and
 * positive values up to Node's timer limit (2147483647 ms) are used as-is.
 * `0`, invalid and out-of-range values fall back to the default with a console
 * warning: shutdown always has a deadline.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  allowInitialModelFallback?: boolean;
  thinkingLevel?: ThinkingLevel;
  fastEnabled?: boolean;
}

interface RpcStartupTimings {
  services?: number;
  modelScope?: number;
  sessionCreate?: number;
  preferences?: number;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as unknown as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

// Tools that belong to the session, not to a branch of it: the ones that reach other tools,
// and pi-web's subagent tools, which the built-in subagent setting switches on for the whole
// session. Navigation keeps them although the target branch was recorded without them.
const SESSION_TOOL_NAMES = new Set<string>(["codemode", "tool_search", ...SUBAGENT_CONTROL_TOOL_NAMES]);

/**
 * The active tools for a coding tool selection. The selection replaces only the coding
 * tools: every other tool named in `carry` that is still registered and not withdrawn stays
 * active, so a tool an extension, `tool_search`, or `defaultTools` activated survives, and a
 * tool one switched off stays off. Nothing else is added: pi itself activates the extension
 * tools it registers (all of them when it builds or reloads a session, then each new one), so
 * `carry` already holds them. An empty selection is Chat only.
 */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    const tool = registered.get(name);
    return tool !== undefined && !codingToolNames.has(name) && tool.exposure !== "hidden";
  });

  return [...new Set([...selectedToolNames, ...carriedToolNames])];
}


// ----------------------------------------------------------------------------
// 未完成工具调用检测（工具中断自动恢复）
// ----------------------------------------------------------------------------

type AgentEndMessageLike = {
  role?: string;
  stopReason?: string;
  content?: Array<{ type?: string; id?: string; name?: string }>;
  toolCallId?: string;
};

/** 每个用户 prompt 周期内自动恢复未完成工具调用的最大次数。 */
const MAX_AUTO_CONTINUE_TURNS = 3;

/**
 * 从 agent_end 携带的完整消息中检查最后一轮 assistant：如果发出了工具调用
 * （toolCall）但没有对应结果（toolResult），说明工具执行被中断，返回第一个
 * 未闭合的调用及其所属消息的 stopReason；全部闭合或没有工具调用时返回 null。
 * 注意这里读的是 SDK 原始消息格式（toolCall 的 id 字段，非 web 层 toolCallId）。
 */
function findUnfinishedToolCall(messages: unknown[]): { toolCallId: string; toolName: string; stopReason?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as AgentEndMessageLike;
    if (msg?.role !== "assistant") continue;
    const toolCalls = (msg.content ?? []).filter((block) => block.type === "toolCall");
    if (toolCalls.length === 0) return null;
    const resultIds = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const result = messages[j] as AgentEndMessageLike;
      if (result?.role === "toolResult" && result.toolCallId) resultIds.add(result.toolCallId);
    }
    for (const call of toolCalls) {
      if (call.id && !resultIds.has(call.id)) {
        return { toolCallId: call.id, toolName: call.name ?? "tool", stopReason: msg.stopReason };
      }
    }
    return null;
  }
  return null;
}

// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class SessionFileConflictError extends Error {
  constructor() {
    super("会话文件已被外部修改，请刷新后重试");
    this.name = "SessionFileConflictError";
  }
}

export class AgentSessionWrapper {
  private readonly diskInspector: SessionDiskInspector;
  // A Set, not an array: an SSE stream unsubscribes from inside emit() when it
  // closes on session_shutdown, and splicing an array mid-iteration made the
  // next stream miss that same event.
  private listeners = new Set<EventListener>();
  private activeToolEvents = new Map<string, AgentEvent>();
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  // SSE 重连时必须先恢复 ask 的完整问题定义，否则逐题 select 会被前端误判为普通单题弹窗。
  private activeAskToolStarts = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private readonly pendingPrompts = new PendingPromptTracker();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private promptRunning = false;
  private sessionReplacement: "fork" | "clone" | null = null;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private readonly mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  private mcpHostDisposed = false;
  // The MCP wait of the prompt being admitted; Stop ends it.
  private mcpPromptWait: { controller: AbortController; done: Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private extensionUiAbortController = new AbortController();
  // abort 期间扩展可能在取消当前问题后继续请求下一题，必须拒绝新 UI 才能真正收口。
  private aborting = false;
  private _alive = true;
  // 工具中断自动恢复状态：最近一次 agent_end 的消息（供 agent_settled 检测）、
  private lastAgentEndMessages: unknown[] | null = null;
  private lastAgentEndWillRetry = false;
  private autoContinueCount = 0;
  private lastAutoContinuedToolCallId: string | null = null;
  // 会话级自动标题只触发一次（成功或跳过都算），避免每条消息都重复检查。
  private autoTitleTriggered = false;
  private readonly shadowSessionSetting: ShadowSessionSetting;
  private readonly fastSessionSetting: FastSessionSetting;
  private fastRuntimeSnapshot: FastRuntimeSnapshot;
  private fastRuntimeGeneration = 0;
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean;
  private readonly suppressCompletionNotifications: boolean;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  // The armed idle timer is the forced cleanup Stop scheduled.
  private forcedIdleTimerArmed = false;
  private resolveDisposed: () => void = () => {};
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  // Set when shutdown() starts. The SDK session stays usable until destroy(),
  // but lookups must treat the wrapper as gone from this point on.
  private closing = false;

  constructor(
    public readonly inner: AgentSessionLike,
    fastModels: ReadonlySet<string> = new Set(),
    generation = "initial",
    options: AgentSessionWrapperOptions = {},
  ) {
    // 已有会话即使在服务加载期间被删，也必须视为磁盘变更。
    this.diskInspector = new SessionDiskInspector(inner.sessionManager, options.persistedSessionFile === true
      || Boolean(inner.sessionFile && existsSync(inner.sessionFile)));
    const modelRuntime = inner.modelRuntime;
    this.fastRuntimeSnapshot = {
      generation: `0:${generation}`,
      catalogModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
      fastModels,
    };
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.chatOnly = options.chatOnly ?? false;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.mcpHost = options.mcpHost;
    const sessionEntries = () => (
      typeof this.inner.sessionManager.getEntries === "function"
        ? this.inner.sessionManager.getEntries()
        : []
    );
    this.shadowSessionSetting = new ShadowSessionSetting({
      entries: sessionEntries,
      appendState: (enabled) => {
        const entryId = this.inner.sessionManager.appendCustomEntry(SHADOW_MIND_SESSION_STATE, { enabled });
        const entry = this.inner.sessionManager.getEntry(entryId);
        if (entry) this.emit({ type: "entry_appended", entry });
      },
      commands: () => this.inner.extensionRunner.getRegisteredCommands(),
      createCommandContext: () => {
        const context = this.inner.extensionRunner.createCommandContext?.();
        if (!context) throw new Error("当前 Pi SDK 不支持扩展命令上下文");
        return context;
      },
    });
    this.fastSessionSetting = new FastSessionSetting({
      entries: sessionEntries,
      currentModel: () => this.inner.model,
      runtimeSnapshot: () => this.fastRuntimeSnapshot,
      setModel: (model) => this.inner.setModel(model),
      appendState: (enabled) => {
        const entryId = this.inner.sessionManager.appendCustomEntry(FAST_SESSION_STATE, { enabled });
        const entry = this.inner.sessionManager.getEntry(entryId);
        if (entry) this.emit({ type: "entry_appended", entry });
      },
    });
  }

  private installFastRuntimeSnapshot(fastModels: ReadonlySet<string>, configGeneration: string): void {
    const modelRuntime = this.inner.modelRuntime;
    this.fastRuntimeGeneration += 1;
    this.fastRuntimeSnapshot = {
      generation: `${this.fastRuntimeGeneration}:${configGeneration}`,
      catalogModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
      fastModels,
    };
  }

  private async reloadRuntime(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
    const snapshot = await readModelsConfigSnapshot();
    await this.inner.reload(options);
    this.installFastRuntimeSnapshot(snapshot.fastModels, snapshot.generation);
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  /**
   * False from the moment shutdown() or destroy() begins, not only once the SDK
   * session is disposed: extensions may take up to the shutdown deadline to
   * handle session_shutdown, and a prompt routed here meanwhile would be lost.
   */
  isAlive(): boolean {
    return this._alive && !this.closing;
  }

  isRunning(): boolean {
    return this._alive && (this.pendingPrompts.active || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  /** 已知 entry id 仍可能被重写；以文件版本变化触发完整内容校验。 */
  diskFreshness(): SessionDiskFreshness {
    return this.isAlive() ? this.diskInspector.inspect(this.sessionFile) : "current";
  }

  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning() || this.diskFreshness() !== "changed") return false;
    if (this.isRunning()) return false;
    console.info("[pi-web] 检测到会话文件外部写入，淘汰空闲会话", { sessionId: this.sessionId });
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "queue_update") {
        // SDK 入队时先广播纯文本事件、再写真实队列；等当前同步调用结束后读取附件。
        queueMicrotask(() => {
          if (this._alive) this.emit({ type: "queue_update", ...readAgentMessageQueue(this.inner.agent) });
        });
        return;
      }
      if (event.type === "message_start" && (event.message as { role?: string } | undefined)?.role === "user") {
        // 纯图片消息不会触发 SDK 的文字匹配移除，也必须同步实际 drain 后的队列。
        this.emit({ type: "queue_update", ...readAgentMessageQueue(this.inner.agent) });
      }
      // SDK 会先广播 message_end，再把消息追加到 SessionManager。首条用户消息到达时
      // 先创建会话文件，后续 SDK 追加即可直接写盘，侧栏刷新也能立即扫描到该会话。
      if (
        event.type === "message_end"
        && (event.message as { role?: string } | undefined)?.role === "user"
      ) {
        this.persistPendingSession();
      }
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        // Every tool call of the run has finished; nothing is left to replay.
        this.activeToolEvents.clear();
        // SDK 的 agent_end 携带完整消息数组；缓存到 agent_settled 时做未闭合工具调用检测
        this.lastAgentEndMessages = Array.isArray(event.messages) ? (event.messages as unknown[]) : null;
        this.lastAgentEndWillRetry = event.willRetry === true;
      }
      if (event.type === "agent_settled") {
        this.maybeAutoContinueUnfinishedTool();
        // 会话第一轮结束后自动生成标题（文件级独立 services，不与主 agent 争用 transport）
        this.maybeAutoTitleSession();
      }
      this.trackActiveToolEvent(event);
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /**
   * 工具中断自动恢复：agent_settled（本轮彻底结束）时，若最后一条 assistant 发出过
   * 工具调用但结果缺失，说明工具执行被中断，自动 follow-up 一次让模型继续完成。
   * 触发限制：用户主动中止（stopReason=aborted）、SDK 即将自动重试（willRetry）或
   * 出错（stopReason=error）时不恢复；每个用户 prompt 周期最多恢复
   * MAX_AUTO_CONTINUE_TURNS 次；同一工具调用不重复恢复（无进展即停止）。
   * 恢复与停止都会向 UI 广播事件。
   */
  private maybeAutoContinueUnfinishedTool(): void {
    if (!this._alive || !this.lastAgentEndMessages) return;
    const unfinished = findUnfinishedToolCall(this.lastAgentEndMessages);
    const willRetry = this.lastAgentEndWillRetry;
    this.lastAgentEndMessages = null;
    this.lastAgentEndWillRetry = false;
    if (!unfinished) return;
    if (willRetry || unfinished.stopReason === "aborted" || unfinished.stopReason === "error") return;
    if (this.autoContinueCount >= MAX_AUTO_CONTINUE_TURNS) {
      this.emit({ type: "auto_continue_stopped", reason: "limit" });
      return;
    }
    if (this.lastAutoContinuedToolCallId === unfinished.toolCallId) {
      this.emit({ type: "auto_continue_stopped", reason: "no_progress" });
      return;
    }
    this.autoContinueCount += 1;
    this.lastAutoContinuedToolCallId = unfinished.toolCallId;
    this.emit({ type: "auto_continue", toolName: unfinished.toolName, toolCallId: unfinished.toolCallId });
    void this.inner.followUp(
      `上一个回合的工具调用 ${unfinished.toolName}（${unfinished.toolCallId}）未能执行完成。`
      + "请继续执行该调用并完成其后续工作；若该调用已不再需要，请说明原因后继续推进剩余任务。",
    ).catch((error) => {
      console.error("[pi-web] auto-continue follow-up failed:", error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * 会话第一轮结束后自动生成标题（每个 wrapper 只尝试一次）。
   * 走文件级独立 services（generateTitleForSessionFile），不借用主 agent 的
   * transport/streamFunction，因此与主会话并行也互不干扰；已有标题、
   * 无 user 消息或文件不可读时会静默跳过。生成成功后广播事件让前端刷新列表。
   */
  private maybeAutoTitleSession(): void {
    if (!this._alive || this.autoTitleTriggered) return;
    const sessionFile = this.inner.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) return;
    this.autoTitleTriggered = true;
    void generateTitleForSessionFile(sessionFile)
      .then((generated) => {
        if (!generated) return;
        invalidateSessionListCache();
        this.emit({ type: "session_title_generated", sessionId: this.inner.sessionId });
      })
      .catch((error) => {
        console.error("[pi-web] auto title generation failed:", error instanceof Error ? error.message : String(error));
      });
  }

  private trackActiveToolEvent(event: AgentEvent): void {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || isNestedToolExecutionEvent(event)) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeToolEvents.set(toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeToolEvents.delete(toolCallId);
      const nestedPrefix = `${toolCallId}/`;
      for (const id of this.activeToolEvents.keys()) {
        if (id.startsWith(nestedPrefix)) this.activeToolEvents.delete(id);
      }
    }
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
        return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      await this.restoreShadowSessionSetting();
      await this.fastSessionSetting.restoreAfterRuntimeReset();
      this.extensionsBound = true;
        console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  /** The session's extension commands as pi looks them up: by invocation name, with the extension's path. */
  private extensionCommandCandidates(): McpCommandCandidate[] {
    try {
      return this.inner.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        sourceInfo: command.sourceInfo,
      }));
    } catch {
      // Unreadable: treat the prompt as one that may start a run, as before.
      return [];
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands" || type === "get_state" || type === "set_shadow_mind_enabled";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async restoreShadowSessionSetting(): Promise<void> {
    const result = await restoreShadowSessionSettingSafely(this.shadowSessionSetting);
    if (!result.ok) {
      console.warn(
        `[pi-web] failed to restore Shadow Mind state for session ${this.inner.sessionId}:`,
        result.error instanceof Error ? result.error.message : result.error,
      );
    }
  }

  /** Apply a coding tool selection; `carry` defaults to the tools active now. */
  setActiveToolSelection(toolNames: string[], carry: readonly string[] = this.inner.getActiveToolNames()): void {
    this.inner.setActiveToolsByName(resolveActiveToolNames(this.inner, toolNames, carry));
  }

  /**
   * pi restores the target branch's loadout from its transcript when it navigates the tree,
   * which can bring back coding tools the pinned preset leaves out and drop codemode, so a
   * normal session applies its selection again. Chat only declares no tools, and a
   * subagent's tools are fixed by its profile; both keep what pi restored.
   */
  private async navigateTreeKeepingToolSelection(
    targetId: string,
    options: { summarize?: boolean },
  ): Promise<{ cancelled: boolean }> {
    const activeBefore = this.inner.getActiveToolNames();
    const result = await this.inner.navigateTree(targetId, options);
    if (result.cancelled || this.chatOnly) return { cancelled: result.cancelled };

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (!readSubagentSessionResources(entries)) {
      const activeAfter = this.inner.getActiveToolNames();
      this.setActiveToolSelection(
        readSessionToolSelection(entries) ?? activeAfter,
        [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
      );
    }
    return { cancelled: false };
  }

  private emit(event: AgentEvent): void {
    if (
      event.type === "tool_execution_start"
      && event.toolName === "ask_user_question"
      && typeof event.toolCallId === "string"
    ) {
      this.activeAskToolStarts.set(event.toolCallId, event);
    } else if (
      event.type === "tool_execution_end"
      && event.toolName === "ask_user_question"
      && typeof event.toolCallId === "string"
    ) {
      this.activeAskToolStarts.delete(event.toolCallId);
    }
    // 固定本次派发快照；单个 SSE 监听器异常不能打断其余客户端或 prompt 收尾。
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[pi-web] session event listener failed:", error instanceof Error ? error.message : error);
      }
    }
    // 统一出口确保扩展 UI 等直接事件不会漏掉；发布器只转发需要用户关注的事件。
    publishAttentionEvent(this.sessionId, event);
  }

  private resetIdleTimer(): void {
    if (!this._alive) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      return;
    }
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    // A stuck user reloads, reopens the session or presses Stop again, and
    // each of those commands lands here. Moving the forced deadline for them
    // would keep a run that Stop cannot unwind alive indefinitely.
    if (this.forceShutdownOnIdle && this.forcedIdleTimerArmed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A resolved timeout of 0 disables idle shutdown, but a run that Stop could
    // not unwind is still reaped after the default delay; otherwise it stays
    // running until the server restarts (#656).
    const timeoutMs = SESSION_IDLE_TIMEOUT_MS
      || (this.forceShutdownOnIdle ? DEFAULT_SESSION_IDLE_TIMEOUT_MS : 0);
    this.forcedIdleTimerArmed = timeoutMs !== 0 && this.forceShutdownOnIdle;
    if (timeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.forceShutdownOnIdle && (this.isRunning() || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, timeoutMs);
  }

  private persistPendingSession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi 默认延迟到首条 assistant 消息才落盘。这里写入 SDK 已生成的 entry 后标记
    // 为已刷新，使紧随当前回调的用户消息或仅包含 bash 的会话继续采用追加写入。
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
    invalidateSessionListCache();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    // ask 问卷必须先于逐题 UI 请求重放。
    for (const event of this.activeAskToolStarts.values()) listener(event);
    for (const event of this.pendingUiRequests.values()) listener(event);
    for (const [toolCallId, event] of this.activeToolEvents) {
      if (!this.activeAskToolStarts.has(toolCallId)) listener(event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 向当前会话的 SSE 订阅者广播应用级事件。 */
  emitEvent(event: AgentEvent): void {
    if (!this._alive) return;
    this.emit(event);
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Resolves `true` once the SDK session is disposed, or `false` after `timeoutMs`:
   * shutdown() waits for extension binding without a deadline.
   */
  waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.disposed.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }

  private async withSessionReplacement<T>(
    replacement: "fork" | "clone",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionReplacement) throw new Error("Session is already being copied");
    this.sessionReplacement = replacement;
    try {
      return await operation();
    } finally {
      if (this._alive) this.sessionReplacement = null;
    }
  }

  private isSessionRunningForReplacement(): boolean {
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPrompts.active;
  }

  private async shutdownAfterSessionReplacement(replacement: "fork" | "clone"): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      console.error(
        `[pi-web] ${replacement} succeeded, but source session shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    // 扩展初始化可能跨越外部写入；实际 dispatch 前再次校验。
    if (!canRunWithExternalSessionChange(type) && this.diskFreshness() !== "current") {
      throw new SessionFileConflictError();
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          const shadowToggle = typeof command.message === "string" ? parseShadowMindToggleCommand(command.message) : null;
          if (shadowToggle !== null) {
            return { kind: "shadow-setting", enabled: await this.shadowSessionSetting.setEnabled(shadowToggle) };
          }
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          if (this.extensionUiAbortController.signal.aborted) {
            this.extensionUiAbortController = new AbortController();
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const promptToken = this.pendingPrompts.begin();
          notifyRunningChange();
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPrompts.finish(promptToken);
            invalidateSessionListCache();
            notifyRunningChange();
            this.resetIdleTimer();
          };

          // A prompt that may start a run first connects the session's MCP servers and
          // waits for the ones still connecting. The SDK runs before_agent_start before a
          // run has an abort signal, so Stop is honoured here: it ends the wait, and the
          // message is rejected unsent, which returns it to the composer. pi runs an
          // extension command before anything else and starts no run for it: another
          // extension's command skips this, and the built-in `/mcp`, which acts on the
          // registered servers, registers them without waiting (`mcpPromptPreparation()`).
          const mcpPreparation = this.mcpHost && !this.inner.isStreaming
            ? mcpPromptPreparation(typeof command.message === "string" ? command.message : "", this.extensionCommandCandidates())
            : "none";
          if (this.mcpHost && mcpPreparation !== "none") {
            const controller = new AbortController();
            const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: mcpPreparation === "wait" })
              .catch((error: unknown) => {
                console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
              })
              .then(() => {
                if (!controller.signal.aborted) return;
                finishPrompt();
                throw new Error(MCP_WAIT_STOPPED_MESSAGE);
              });
            const wait = { controller, done: waited.then(() => undefined, () => undefined) };
            this.mcpPromptWait = wait;
            try {
              await waited;
            } finally {
              if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
            }
          }
          this.autoContinueCount = 0;
          this.lastAutoContinuedToolCallId = null;
          const loadedSkills = this.inner.resourceLoader.getSkills().skills;
          const multiSkill = expandMultiSkillCommand(command.message as string, loadedSkills);
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(multiSkill.text, {
              ...(multiSkill.expanded ? { expandPromptTemplates: false } : {}),
              ...(promptImages?.length ? { images: promptImages } : {}),
              streamingBehavior: streamingBehavior ?? "followUp",
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              // Every disposition (handled, queued, started) is an acceptance; a
              // rejected prompt never calls this and rejects `prompt` instead.
              preflightResult: () => acceptPreflight(),
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort": {
        if (this.aborting) return null;
        this.aborting = true;
        this.forceShutdownOnIdle = true;
        this.resetIdleTimer();
        clearAttentionSession(this.sessionId);
        try {
          // Stop 必须先打断等待用户输入的扩展命令，否则 SDK 会一直等待 idle。
          this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
          if (this.mcpPromptWait) {
            const wait = this.mcpPromptWait;
            wait.controller.abort();
            await wait.done;
          }
          this.activeAskToolStarts.clear();
          await this.withFinalRunningNotification(() => this.inner.abort());
        } finally {
          this.aborting = false;
        }
        return null;
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        const queuedMessages = readAgentMessageQueue(this.inner.agent);
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.pendingPrompts.active,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: queuedMessages.steering.length + queuedMessages.followUp.length,
          queuedMessages,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          // An exact prompt is projected onto each run by the inline extension. Every other
          // session reports `agent.state.systemPrompt`, which replays the transcript: that is
          // what the model actually saw, including sections a `before_agent_start` handler
          // changed for the run. It stays empty until the first run persists a system message,
          // so a session that has not sent anything yet falls back to the session getter, which
          // renders the prompt from the current options. The getter alone would drop those
          // per-run changes again once the run ends.
          systemPrompt: this.exactSystemPrompt?.() ?? (this.inner.agent.state?.systemPrompt || this.inner.systemPrompt || ""),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          fastEnabled: this.fastSessionSetting.current,
          fastAvailable: this.fastSessionSetting.available,
          shadowMindEnabled: this.shadowSessionSetting.current,
          shadowMindAvailable: this.shadowSessionSetting.available,
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.fastSessionSetting.selectModel(model);
        updateCachedDefaultModel(this.cwd, { provider: model.provider, modelId: model.id });
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!existsSync(currentSessionFile)) throw new Error("Session has not been saved yet");

        // 文件级 Fork 不改变当前 AgentSession，因此原会话生成期间也可复制已落盘历史。
        const { newSessionId, newSessionFile } = createForkedSession(currentSessionFile, entryId);
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "fork_branch": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!existsSync(currentSessionFile)) throw new Error("Session has not been saved yet");
        const selectedEntry = sessionManager.getEntry(entryId);
        if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "assistant") {
          throw new Error("Only assistant messages can start a quoted branch");
        }

        // 使用隔离暂存目录创建文件级分支，不能让 SDK 替换当前会话实例或源文件。
        const { newSessionId, newSessionFile } = createForkedSession(currentSessionFile, entryId);
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "clone": {
        if (this.isRunning()) throw new Error("Cannot clone while the session is running");
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        // 无 assistant 历史时没有可复制的答复，按原生命令契约返回取消。
        if (leafId && !sessionManager.getBranch(leafId).some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
          return { cancelled: true };
        }
        if (!sessionManager.isPersisted() || !currentSessionFile || !existsSync(currentSessionFile) || !leafId) {
          return { cancelled: true };
        }

        const { newSessionId, newSessionFile } = createClonedSession(currentSessionFile, leafId);
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        return this.navigateTreeKeepingToolSelection(command.targetId as string, {});
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "set_shadow_mind_enabled": {
        const enabled = await this.shadowSessionSetting.setEnabled(command.enabled === true);
        return { enabled };
      }

      case "set_fast_enabled": {
        const enabled = await this.fastSessionSetting.setEnabled(command.enabled === true);
        return { enabled, available: this.fastSessionSetting.available };
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return recallAgentMessageQueue(this.inner);
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        // A hidden tool is withdrawn: pi ignores it when setting the active tools.
        const all: ToolInfo[] = this.inner.getAllTools().filter((t) => t.exposure !== "hidden");
        const active = new Set<string>(this.inner.getActiveToolNames());
        // The definition's description is not always what the model gets: `prepareLoadout`
        // hooks rewrite the declared ones (codemode lists its nested tools and the MCP types).
        const declared = new Map((this.inner.agent.state?.tools ?? []).map((t) => [t.name, t.description]));
        // Active and callable, but requests leave the declaration out: codemode's "only" mode
        // does this to active `direct` tools. The set is private to pi 0.99's AgentSession.
        const hiddenDeclarations: unknown = Reflect.get(this.inner, "_hiddenDeclarations");
        const hidden = hiddenDeclarations instanceof Set ? hiddenDeclarations : new Set<unknown>();
        return all.map((t) => ({
          ...t,
          description: declared.get(t.name) ?? t.description,
          active: active.has(t.name),
          declarationHidden: hidden.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        this.setActiveToolSelection(toolNames);
            return null;
      }

      case "reload": {
        if (this.extensionUiAbortController.signal.aborted) {
          this.extensionUiAbortController = new AbortController();
        }
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        const activeToolNames = this.inner.getActiveToolNames();
        await this.reloadRuntime();
        // pi rebuilds from the tools active before, then extensions adjust them as they start
        // again; carry that result so a tool one switched off during reload stays off.
        this.setActiveToolSelection(activeToolNames);
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        await this.restoreShadowSessionSetting();
        await this.fastSessionSetting.restoreAfterRuntimeReset();
        invalidateModelsCache(this.cwd);
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.pendingPrompts.active || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistPendingSession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.resetIdleTimer();
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  /**
   * Once, as closing starts and before extensions hear session_shutdown: the
   * MCP host's own handler runs after every other extension's, and one that
   * never returns would leave its records behind (lib/mcp-host.ts).
   */
  private disposeMcpHost(): void {
    if (this.mcpHostDisposed) return;
    this.mcpHostDisposed = true;
    try {
      this.mcpHost?.dispose();
    } catch (error) {
      console.error("[pi-web] MCP host dispose failed:", error instanceof Error ? error.message : error);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    clearAttentionSession(this.sessionId);
    this.disposeMcpHost();
    // Tell attached SSE listeners to drop this instance so the browser
    // EventSource errors and reconnects instead of staying OPEN on a dead wrapper.
    this.emit({ type: "session_shutdown" });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeAskToolStarts.clear();
    this.activeToolEvents.clear();
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        try {
          this.onDestroyCallback?.();
        } finally {
          notifyRunningChange();
          this.resolveDisposed();
        }
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void this.emitSessionShutdown(emit)
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;
    // Closing starts before the first await, so a request that arrives while
    // extensions shut down starts a fresh wrapper instead of prompting this one.
    this.closing = true;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        // After binding, so the host's session_start has run and finds nothing to record later.
        this.disposeMcpHost();
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          const emit = this.inner.extensionRunner?.emit;
          if (typeof emit === "function") await this.emitSessionShutdown(emit);
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Gives extensions at most SESSION_SHUTDOWN_DEADLINE_MS to handle
   * session_shutdown, then returns so the SDK session is disposed and
   * unregistered anyway. Closing an MCP connection has no upper bound: it waits
   * for a token refresh in flight and for a stdio child whose daemonized
   * grandchild may never close stdout.
   */
  private async emitSessionShutdown(
    emit: NonNullable<AgentSessionLike["extensionRunner"]["emit"]>,
  ): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), SESSION_SHUTDOWN_DEADLINE_MS);
      // A quitting process must not wait for an extension's cleanup.
      deadlineTimer.unref?.();
    });
    // A synchronous throw becomes a rejection, and a rejection that arrives
    // after the deadline is still handled by the race below.
    const handled = (async () => {
      await emit.call(this.inner.extensionRunner, { type: "session_shutdown", reason: "quit" });
      return "handled" as const;
    })();
    try {
      if (await Promise.race([handled, deadline]) === "timeout") {
        console.warn(
          `[pi-web] extensions did not finish session_shutdown for session ${this.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms; disposing it anyway`,
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values()).filter((widget) => widget.lines.length > 0);
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => completed ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    options: { timeout?: number; signal?: AbortSignal; required?: boolean } = {},
  ): Promise<T> {
    const required = options.required === true;
    const timeout = options.timeout;
    const signal = options.signal;
    const stopSignal = this.extensionUiAbortController.signal;
    const abortForUiFailure = (reason: string, reject: (error: Error) => void): void => {
      reject(new Error(`Required user interaction failed: ${reason}`));
      if (required && !this.aborting) {
        void this.send({ type: "abort" }).catch((error) => {
          console.error(`[pi-web] failed to abort after ask UI failure (${reason}):`, error instanceof Error ? error.message : error);
        });
      }
    };
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    if (signal?.aborted) {
      if (required) return Promise.reject(new Error("Required user interaction was aborted"));
      return Promise.resolve(defaultValue);
    }
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        this.emit({ type: "extension_ui_closed", id });
      };
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (required) abortForUiFailure(reason, reject);
        else resolve(defaultValue);
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onAbort = () => {
        if (!stopSignal.aborted) {
          fail("abort or cancellation");
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        reject(stopSignal.reason);
      };

      if (timeout) timeoutId = setTimeout(() => fail("timeout"), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => {
          if (required && ("cancelled" in response || !("value" in response) && !("confirmed" in response))) {
            fail("user cancelled");
            return;
          }
          settle(parseResponse(response));
        },
        cancel: () => stopSignal.aborted ? onAbort() : fail("wrapper shutdown"),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        { timeout: opts?.timeout, signal: opts?.signal },
      ),
      requiredSelect: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        { timeout: opts?.timeout, signal: opts?.signal, required: true },
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        { timeout: opts?.timeout, signal: opts?.signal },
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        { timeout: opts?.timeout, signal: opts?.signal },
      ),
      requiredInput: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        { timeout: opts?.timeout, signal: opts?.signal, required: true },
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        { timeout: opts?.timeout, signal: opts?.signal },
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: (targetId, options) =>
        this.navigateTreeKeepingToolSelection(targetId, { summarize: options?.summarize }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.reloadRuntime({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        await this.fastSessionSetting.restoreAfterRuntimeReset();
          },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  // A closing wrapper reports itself dead while extensions shut down, so the
  // next request registers a replacement under the same id. Finishing later,
  // the closing wrapper must not unregister that replacement.
  wrapper.onDestroy(() => {
    if (registry.get(sessionId) === wrapper) registry.delete(sessionId);
  });
  // A wrapper registered before a hot reload still unregisters by id alone.
  const previous = registry.get(sessionId);
  if (previous && previous !== wrapper && typeof previous.onDestroy === "function") {
    previous.onDestroy(() => {});
  }
  registry.set(sessionId, wrapper);
  wrapper.start();
  if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, new Set(), "subagent", {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: options.exactSystemPrompt }
        : {}),
      chatOnly: options?.chatOnly,
      suppressCompletionNotifications: true,
    });
    registerRpcWrapper(wrapper);
  },
  reopenSession: async (sessionId, sessionFile) => (
    await startRpcSession(sessionId, sessionFile, undefined)
  ).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  isBuiltInSubagentsEnabled,
});

export function getSubagentRun(sessionId: string) {
  return SUBAGENT_CONTROLLER.get(sessionId);
}

export function steerSubagent(sessionId: string, message: string) {
  return SUBAGENT_CONTROLLER.steer(sessionId, message);
}

export function abortSubagent(sessionId: string) {
  return SUBAGENT_CONTROLLER.abort(sessionId);
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

const CLOSING_SESSION_WAIT_MARGIN_MS = 1_000;
const closingSessionWaits = new WeakMap<AgentSessionWrapper, { done: boolean; promise: Promise<void> }>();

/**
 * The wait for a wrapper of `sessionId` that is shutting down, or null when there is none
 * left to wait for. Until it is disposed the closing wrapper still owns the session: an
 * extension's session_shutdown may append to the file, which a replacement opened earlier
 * would branch away from, and dispose() releases provider resources (a Codex websocket) by
 * session id, which the replacement shares. The wait is bounded so a shutdown stuck in
 * extension binding cannot keep the session from starting again. One wait per closing
 * wrapper: its bound runs from the first caller and later callers share it, so a
 * shutdown still binding extensions can be overtaken.
 */
function closingRpcSessionWait(sessionId: string): Promise<void> | null {
  const closing = getRegistry().get(sessionId);
  // A wrapper from before a hot reload may lack waitUntilDisposed.
  if (!closing || closing.isAlive() || typeof closing.waitUntilDisposed !== "function") return null;
  let wait = closingSessionWaits.get(closing);
  if (!wait) {
    const entry = { done: false, promise: Promise.resolve() };
    entry.promise = closing.waitUntilDisposed(SESSION_SHUTDOWN_DEADLINE_MS + CLOSING_SESSION_WAIT_MARGIN_MS)
      .then((disposed) => {
        if (!disposed) console.warn(`[pi-web] session ${sessionId} is still shutting down; starting it again anyway`);
      })
      .finally(() => { entry.done = true; });
    closingSessionWaits.set(closing, entry);
    wait = entry;
  }
  return wait.done ? null : wait.promise;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/**
 * Persist a normal session's tool selection and rebuild when resource policy changes.
 * An undefined requestedToolNames returns the session to pi's configured defaults:
 * the pin is retracted and the session is rebuilt, because the loadout that
 * settings.json defaultTools resolves to is only known once pi builds the session.
 */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    // A wrapper still closing, or a start already under way, owns the file: wait for it and
    // apply the selection to whatever it left, or a start that opened the file first would
    // come up without the selection while this call reported success.
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
    }
    const manager = SessionManager.open(sessionFile, undefined);
    if (new SessionDiskInspector(manager, true).inspect(sessionFile) !== "current") {
      throw new SessionFileConflictError();
    }
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    if (toolNames === undefined) appendClearedSessionToolSelection(manager);
    else appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (existing.diskFreshness() !== "current") throw new SessionFileConflictError();
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  if (toolNames === undefined) appendClearedSessionToolSelection(existing.inner.sessionManager);
  else appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (toolNames !== undefined && !crossesChatOnlyBoundary) {
    existing.setActiveToolSelection(toolNames);
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSession(`__recreate__${randomUUID()}`, "", sessionCwd, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    allowInitialModelFallback: true,
    ...(currentThinkingLevel && THINKING_LEVEL_NAMES.has(currentThinkingLevel as ThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel as ThinkingLevel }
      : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && !options.includeTransient && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp ?? entries[0]?.timestamp ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

/** 统一生成会话运行快照，避免 alive/running/busy 在不同路由中产生不同语义。 */
export async function getRpcSessionSnapshot(sessionId: string): Promise<AgentRuntimeSnapshot> {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) return { alive: false, busy: false };

  const state = await session.send({ type: "get_state" }) as AgentRuntimeState;
  return { alive: true, busy: session.isRunning(), state };
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { initialModel, allowInitialModelFallback, thinkingLevel, fastEnabled } = options;
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const closingWait = closingRpcSessionWait(sessionId);
  if (closingWait) {
    // Concurrent starts share this lock, then the one start that follows it.
    const waiting: Promise<{ session: AgentSessionWrapper; realSessionId: string }> = closingWait.then(() => {
      if (locks.get(sessionId) === waiting) locks.delete(sessionId);
      return startRpcSession(sessionId, sessionFile, cwd, options);
    });
    locks.set(sessionId, waiting);
    return waiting;
  }

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    sessionManager = SessionManager.create(cwd, undefined);
  }
  isolateToolResultPersistence(sessionManager);
  const sessionCwd = sessionManager.getCwd();
  const sessionEntries = sessionManager.getEntries() as unknown as SessionEntry[];
  const subagentResources = sessionFile ? readSubagentSessionResources(sessionEntries) : null;
  const persistedToolNames = subagentResources ? undefined : readSessionToolSelection(sessionEntries);
  const selectedToolNames = subagentResources?.tools ?? persistedToolNames ?? requestedToolNames;
  if (!subagentResources && persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(sessionManager, requestedToolNames);
  }
  const subagentLoadsResources = Boolean(
    subagentResources?.loadExtensions || subagentResources?.loadSkills,
  );
  const chatOnly = selectedToolNames?.length === 0 && !subagentLoadsResources;
  const finishStartingSession = trackStartingSession(sessionCwd);
  const startupStartedAt = performance.now();
  const startupTimings: RpcStartupTimings = {};
  let startupStage = "setup";
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined = subagentResources?.tools;
    if (!subagentResources && selectedToolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = selectedToolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = subagentResources
      ? subagentLoadsResources
        ? projectTrustReloadOptions(sessionCwd, agentDir)
        : undefined
      : chatOnly
        ? undefined
        : projectTrustReloadOptions(sessionCwd, agentDir);
    const settingsManager = SettingsManager.create(sessionCwd, agentDir);
    startupStage = "services";
    let stageStartedAt = performance.now();
    const modelConfigSnapshot = await readModelsConfigSnapshot();
    // Chat-only sessions and subagents that replace Pi's prompt send an exact
    // system prompt. The prompt is resolved at prompt time through this inline
    // extension: it may read the session's context files, which exist only
    // after the session is created, so the getter is filled in below.
    const exactSystemPromptRef: { current?: () => string } = {};
    const exactSystemPromptExtension = createExactSystemPromptExtension(() => exactSystemPromptRef.current?.());
    // codemode, tool-search, and mcp, as the pi CLI loads them, and the host that decides
    // which MCP servers the session connects (ADR 0006).
    const builtins = subagentResources || chatOnly
      ? undefined
      : await createPiWebBuiltinExtensions({ agentDir });
    const skillsBinding = subagentResources ? createSubagentSkillsBinding({
      loadSkills: subagentResources.loadSkills,
      skills: subagentResources.skills,
      exactSystemPrompt: subagentResources.exactSystemPrompt
        ?? (chatOnly ? subagentResources.appendSystemPrompt[0] ?? "" : undefined),
    }) : undefined;
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            ...subagentExtensionLoaderOptions(subagentResources),
            ...skillsBinding!.loaderOptions,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            ...(chatOnly
              ? { systemPrompt: " ", systemPromptOverride: () => undefined }
              : {}),
            appendSystemPrompt: subagentResources.appendSystemPrompt,
          }
        : chatOnly
          ? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: [exactSystemPromptExtension] }
        : {
            extensionFactories: [
              ...(builtins?.extensions ?? []),
              createReadOnlyMcpPolicyExtension(),
              createProjectCommandBashExtension({
                cwd: sessionCwd,
                settings: settingsManager,
              }),
              createSubagentExtension(
                SUBAGENT_CONTROLLER.extensionRuntime,
                () => listSubagentProfiles(sessionCwd),
                isBuiltInSubagentsEnabled,
              ),
            ],
            extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
          },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const modelConfigAfterServices = await readModelsConfigSnapshot();
    if (modelConfigSnapshot.generation !== modelConfigAfterServices.generation) {
      throw new Error("模型配置在 runtime 创建期间发生变化，请重试");
    }
    startupTimings.services = elapsedMs(stageStartedAt);

    startupStage = "modelScope";
    stageStartedAt = performance.now();
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    startupTimings.modelScope = elapsedMs(stageStartedAt);
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    // 系统消息描述运行时提示词，不代表对话已经开始；已有会话优先恢复分支记录的模型。
    const branch = sessionManager.getBranch();
    const hasExistingMessages = branch.some((entry) => entry.type === "message" && entry.message.role !== "system");
    const savedModel = hasExistingMessages ? getLatestModelChange(branch as unknown as SessionEntry[]) : null;
    const restoredModel = savedModel
      ? services.modelRuntime.getModel(savedModel.provider, savedModel.modelId)
      : undefined;
    const effectiveInitialModel = initialModel && (
      !allowInitialModelFallback
      || scope.visible.some((model) => model.provider === initialModel.provider && model.id === initialModel.modelId)
    ) ? initialModel : undefined;
    const initial = hasExistingMessages
      ? { scopedModels: [...scope.scopedModels] }
      : selectInitialModelScope(scope, {
        ...(effectiveInitialModel ? { requestedModel: effectiveInitialModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
      ? restoredModel
      : initial?.model;
    startupStage = "sessionCreate";
    stageStartedAt = performance.now();
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(startupModel ? { model: startupModel } : {}),
      ...(initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(scope.scopedModels.length > 0 ? { scopedModels: [...scope.scopedModels] } : {}),
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(subagentResources ? { excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES] } : {}),
    });
    startupTimings.sessionCreate = elapsedMs(stageStartedAt);

    startupStage = "preferences";
    stageStartedAt = performance.now();
    const persistedPreferences = await persistExplicitStartupPreferences(
      services.settingsManager,
      {
        ...(effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      {
        ...(inner.model
          ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
          : {}),
        thinkingLevel: inner.thinkingLevel,
        supportsThinking: inner.supportsThinking(),
      },
    );
    startupTimings.preferences = elapsedMs(stageStartedAt);
    if (persistedPreferences.modelDefaultChanged && inner.model) {
      updateCachedDefaultModel(sessionCwd, { provider: inner.model.provider, modelId: inner.model.id });
    }

    // A pinned selection replaces only the coding tools of the SDK's initial loadout, which
    // already holds the extension tools pi activates on registration and whatever
    // `defaultTools` names (such as `+codemode`), so installed extensions stay usable in
    // Pi Web just like in the `pi` CLI.
    if (!subagentResources && !chatOnly) {
      const initialToolNames = inner.getActiveToolNames();
      inner.setActiveToolsByName(
        resolveActiveToolNames(inner, selectedToolNames ?? initialToolNames, initialToolNames),
      );
    }

    skillsBinding?.setActiveToolsGetter(() => inner.getActiveToolNames());
    const exactSystemPrompt = subagentResources
      ? skillsBinding!.getExactSystemPrompt
      : chatOnly
        ? () => contextFilesSystemPrompt(inner.resourceLoader.getAgentsFiles().agentsFiles)
        : undefined;
    exactSystemPromptRef.current = exactSystemPrompt;
    const wrapper = new AgentSessionWrapper(
      inner,
      modelConfigSnapshot.fastModels,
      modelConfigSnapshot.generation,
      {
        exactSystemPrompt,
        chatOnly,
        suppressCompletionNotifications: Boolean(subagentResources),
        persistedSessionFile: Boolean(sessionFile),
        ...(builtins?.mcpHost ? { mcpHost: builtins.mcpHost } : {}),
      },
    );
    registerRpcWrapper(wrapper);
    if (fastEnabled !== undefined) {
      try {
        await wrapper.send({ type: "set_fast_enabled", enabled: fastEnabled });
      } catch (error) {
        wrapper.destroy();
        throw error;
      }
    }

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    console.info("[pi-web] RPC session startup", {
      sessionId: realSessionId,
      cwd: sessionCwd,
      existingSession: Boolean(sessionFile),
      total: elapsedMs(startupStartedAt),
      ...startupTimings,
    });
    return { session: wrapper, realSessionId };
  })().catch((error) => {
    console.error("[pi-web] RPC session startup failed", {
      cwd: sessionCwd,
      existingSession: Boolean(sessionFile),
      stage: startupStage,
      total: elapsedMs(startupStartedAt),
      ...startupTimings,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }).finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}
