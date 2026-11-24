"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { stripAnsi } from "@/lib/ansi";
import { mergeExtensionUiSnapshot } from "@/lib/extension-ui-runtime-state";
import type {
  UserMessage,
  ToolResultMessage,
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import type { AgentRuntimeSnapshot, AgentRuntimeState, AgentSubmitAcknowledgement } from "@/lib/agent-state";
import type { ModelEntry, SelectedModel, ThinkingLevelMap } from "@/lib/model-types";
import type { ModelSelectionViewActions, ModelSelectionViewState } from "@/lib/model-selection-types";
import { resolveFastModeAvailability } from "@/lib/fast-mode";
import { deleteSessionViewSnapshot, getSessionViewSnapshot, setSessionViewSnapshot } from "@/lib/session-view-cache";
import { userMessageKey } from "@/lib/prompt-recovery";

import { clampThinkingLevelToSupported, isThinkingLevel, parseThinkingLevelOption, resolveDisplayedThinkingLevel, type ThinkingLevel, type ThinkingLevelOption } from "@/lib/thinking-levels";
import { recordThinkingLevelPreference } from "@/lib/thinking-level-preference-client";
import { createNewSessionRuntime, materializeNewSession, submitNewSessionFirstPrompt, releaseNewSessionMaterialization, type NewSessionMaterializationResult } from "@/lib/new-session-materialization-client";
import { selectNewSessionRequest, selectPendingNewSession, type PendingNewSessionControl, type PendingNewSessionEvent, type ThinkingLevelSource } from "@/lib/pending-new-session";
import { beginDraftModelSwitch, getDraftModelSwitch, isLatestDraftModelSwitch, registerDraftModelSwitch, settleDraftModelSwitch, waitForDraftModelSwitchTask, type DraftModelSelection } from "@/lib/draft-model-switch";
import { latestPendingNewSessionControl } from "@/lib/pending-new-session-mirror";
import { projectExtensionBinding } from "@/lib/new-session-protocol";
import { retryModelLoad, useModelSelection } from "@/hooks/useModelSelection";
import { useFrameBatchedStreamDispatch } from "@/hooks/useFrameBatchedStreamDispatch";
import { useRunCompletion } from "@/hooks/useRunCompletion";
import { STREAM_CLOSED, STREAM_OPEN, createStreamSource, type StreamEventSource } from "@/lib/sse-broker-client";
import { SESSION_BINDING_DEADLINE_MS, useSessionBindingPoll } from "@/hooks/useSessionBindingPoll";
import { createSideChat, SIDE_REFUSAL_MESSAGES } from "@/lib/side-chat-client";
import {
  clearManualStopNotificationSuppression,
  markManualStopNotificationSuppressed,
} from "@/lib/manual-stop-notification";
export type { ThinkingLevelOption } from "@/lib/thinking-levels";
import { normalizeAssistantMessage } from "@/lib/normalize";
import { getPreferredCustomTools, getPreferredToolPreset, setPreferredCustomTools, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import type { ToolPreset } from "@/lib/tool-presets";
import { AgentCommandError, EXTENSION_REPORTED_CODE, agentStatusUrl, isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import { peekPageId } from "@/lib/page-debug";
import { commandNameOf, runStatePhase } from "@/lib/chat-phase-label";
import { SESSION_LEASE_TIMEOUT_MS, type SessionLeaseReply } from "@/lib/agent-event-connection";
import type { DebugClientLease, DebugClientSession } from "@/lib/debug-types";
import type { TranslationParams } from "@/lib/i18n/types";
import { isSessionExternalWriteError } from "@/lib/session-external-write";
import { prependChatDraft, queuedMessagesToDraft, type QueuedMessages } from "@/lib/queued-messages";
export type { QueuedMessages } from "@/lib/queued-messages";
import {
  clearDraftRestorePending,
  getDraft,
  hasPendingDraftRestore,
  markDraftRestorePending,
  notifyRecalledDraft,
  parkedNewSessionDraftKey,
  setDraft,
  subscribeDraftRestore,
  type ChatDraft,
  captureDraftTransfer,
  type DraftTransfer,
} from "@/lib/draft-store";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames, getToolNamesForPreset, normalizeBuiltinToolName, SETTINGS_BUILTIN_TOOLS, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { createShownNotices, extensionErrorMessage } from "@/lib/startup-issues";
import type { BashResultLike } from "@/lib/pi-types";
import { formatSessionSummary } from "@/lib/session-stats-format";
import { carryMessageKeys, messageRenderKeys } from "@/lib/message-keys";
import { isNestedToolExecutionEvent, isSystemMessageEvent } from "@/lib/agent-event-wire";
import { CODEMODE_TOOL_NAME, getCodemodeProgress } from "@/lib/codemode-view";
import { bareMcpOpensSettings } from "@/lib/mcp-command";
import { copyText } from "@/lib/clipboard";
import type { SettingsSection } from "@/lib/settings-navigation";
import { NOTICE_VISIBLE_MS, noticeReducer, type NoticeType } from "@/lib/notice-state";
import { withTranscriptNotices, type TranscriptNotice } from "@/lib/transcript-notices";
import { applyToolClockEvent, endedToolClocks, NO_TOOL_CLOCKS, withoutToolClock, type ToolClocks } from "@/lib/tool-clock";
import {
  fetchRuntimeState,
  fetchSessionContext,
  fetchSessionDetails,
  type SessionContextSnapshot,
  type SessionDetails,
  invalidateSessionContext,
} from "@/lib/session-load-client";
import { backfillFirstPage, mergeOlderPage, sameSessionView } from "@/lib/first-page-backfill";
import { LatestContextLoader } from "@/lib/latest-context-loader";
import { createIdleMessageReads, entriesAfter, mergeBranchTailEntryIds } from "@/lib/idle-message-read";
import { SessionContextRefreshScheduler } from "@/lib/session-context-refresh-scheduler";
import { ShadowLifecycleCoordinator } from "@/lib/shadow-lifecycle";
import { useShadowSessionSetting } from "@/hooks/useShadowSessionSetting";
import { getCompactionScrollPosition, type ChatScrollPosition, type ChatScrollPositionRequest } from "@/lib/chat-scroll-position";
import {
  createStreamingStore,
  type ClientAssistantMessageEvent,
} from "@/lib/streaming-message";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import type { SessionListRefreshRequest } from "@/lib/session-list-refresh-coordinator";

/** 草稿的档位修订号（用户手动改档的次数）；不是设置态的草稿没有这个字段。 */
function settingsLevelRevision(control: PendingNewSessionControl | null): number | undefined {
  return control && "levelRevision" in control ? control.levelRevision : undefined;
}

const SESSION_CONTEXT_PAGE_SIZE = 50;
/** 单页历史的期限：服务端卡住时不能让顶部一直停在「加载中」，超时按失败处理，按钮可重试。 */
const EARLIER_PAGE_TIMEOUT_MS = 30_000;

interface HistoryPageState {
  sid: string | null;
  oldestEntryId: string | null;
  hasMore: boolean;
  turnsBefore: number;
  loading: boolean;
  /** 上一个游标那一页超时/出错：顶部哨兵不再自动重发，改由用户点「重试」。 */
  failed: boolean;
}

/**
 * 会话文件在页面打开期间被删除/归档（分页接口 404）：关掉历史分页。
 * 不挂重试——重试一个已经不在的文件只会一直失败；普通翻页和大纲跳转共用这一条。
 */
function terminatePagination(current: HistoryPageState, sid: string): HistoryPageState {
  return current.sid === sid ? { ...current, loading: false, failed: false, hasMore: false } : current;
}

/**
 * 给单页请求加期限，同时跟随外层的取消信号（切换会话、分支导航）。
 *
 * 不用 `AbortSignal.any()` / `AbortSignal.timeout()`：它们分别要到 Safari 17.4 / 16.4 才有，
 * 更老的 Safari 会在发出请求前直接抛 TypeError —— 本来能翻的历史就再也翻不出来了。
 */
function withPageDeadline(signal: AbortSignal, ms: number, onTimeout: () => void): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    onTimeout();
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    },
  };
}
/** 大纲跳转的按需翻页：页更大、页数更宽，才能从当前页一路走到会话第一轮。 */
const JUMP_PAGE_SIZE = 200;
const MAX_JUMP_PAGES = 200;

interface PendingBash {
  command: string;
  excludeFromContext: boolean;
  startedAt: number;
  liveOutput?: string;
  result?: BashResultLike;
}
type DetachedSubagentMode = "auto-resume" | "next-turn";
/** 一次运行态读取的坐标：读取序号与队列、压缩、思考强度和扩展 UI 的事件版本。 */
interface RuntimeRead {
  seq: number;
  queueGeneration: number;
  compactionEpoch: number;
  /** 取这份快照时用户档位选择的版本：之后用户改过档，这份快照的档位就是旧的。 */
  thinkingRevision: number;
  /** 实时扩展 UI 按字段记版本，状态事件不能误伤仍有效的 widget 快照。 */
  extensionStatusesRevision: number;
  extensionWidgetsRevision: number;
}

export interface DetachedSubagentStatus {
  id: string;
  agent: string;
  task: string;
  mode: DetachedSubagentMode;
  state: "running" | "completed" | "failed";
  error?: string;
}

export interface ShadowReportStatus {
  id: string;
  agent: "shadow-report";
  task: string;
  mode: "shadow-report";
  state: "running";
}

export type SubagentStatus = DetachedSubagentStatus | ShadowReportStatus;
export type TodoItemStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  subject: string;
  status: TodoItemStatus;
  description?: string;
  activeForm?: string;
  blockedBy?: number[];
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

function filterVisibleExtensionWidgets(widgets: ExtensionWidgetItem[]): ExtensionWidgetItem[] {
  return widgets.filter((widget) => widget.lines.length > 0);
}


interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

// ask（select）的 "Type something." 行内输入接力：前端先回送 sentinel 原文触发
// rpc-fallback 的 input 分支，pi 随即发来 method:"input" 请求；此处记录待提交文本，
// 在 input 请求到达时自动应答，使自定义答案无需弹窗即可提交。
// 超时兜底：pi 侧异常未发 input 时，残留记录自动失效，避免误应答后续无关请求。
const CUSTOM_ANSWER_ARM_MS = 15_000;
// 上游的会话存活改由页面续租维持（#1445）；SSE 不再保活，选中的会话必须定期续租。
const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;
type SessionLeaseOutcome = SessionLeaseReply | "unanswered" | null;

/**
 * A normal send whose prompt request failed without the server's refusal (#1432):
 * what to give back should the server turn out never to have got it.
 */
type UnconfirmedSend = {
  runId: number;
  sid: string;
  message: string;
  images?: AttachedImage[];
  draftKey: string | undefined;
  /** A fresh composer's: the cwd's parked draft, which the next fresh composer there takes back. */
  parkedDraftKey: string | null;
  /** The view's last saved entry when the prompt was sent: the prompt can only show up after it. */
  lastEntryIdAtSend: string | null;
  /** User messages with the same text the view already had after that entry (sent before, not saved yet when read). */
  sameTextAfterSend: number;
  /** The optimistic bubble, dropped with its text's return once a read shows the prompt is not there. */
  bubble: AgentMessage;
  /** userMessageKey() of the optimistic bubble: the user message the prompt becomes. */
  key: string;
  /** A slash command: an extension command or template need not become that user message. */
  command: boolean;
};

/** The messages without that one (by identity, its last occurrence); the same array when it is absent. */
function withoutMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const index = messages.lastIndexOf(message);
  return index === -1 ? messages : [...messages.slice(0, index), ...messages.slice(index + 1)];
}

function countUserMessages(messages: readonly AgentMessage[], key: string): number {
  return messages.reduce((count, message) => (
    message.role === "user" && userMessageKey(message) === key ? count + 1 : count
  ), 0);
}


function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.type === "text" ? block.text ?? "" : "").join("\n");
}

function completedDetachedSubagentIds(message: AgentMessage): string[] {
  if (message.role !== "custom" || message.customType !== "pi-subagent-completion") return [];
  const details = message.details as {
    agentId?: unknown;
    completions?: Array<{ agentId?: unknown }>;
  } | undefined;
  if (typeof details?.agentId === "string") return [details.agentId];
  return details?.completions
    ?.map((completion) => completion.agentId)
    .filter((agentId): agentId is string => typeof agentId === "string") ?? [];
}
function pendingDetachedSubagentIds(messages: AgentMessage[]): Set<string> {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolName === "subagent_spawn" && !message.isError) {
      const text = contentText(message.content);
      const agentId = text.match(/\b(sa_[0-9a-f-]+)\b/i)?.[1];
      if (agentId) pending.add(agentId);
      continue;
    }
    for (const agentId of completedDetachedSubagentIds(message)) pending.delete(agentId);
  }
  return pending;
}

function deriveDetachedSubagentStatuses(messages: AgentMessage[]): DetachedSubagentStatus[] {
  const statuses = new Map<string, DetachedSubagentStatus>();
  const completedAt = new Map<string, number>();
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const [agentId, index] of completedAt) {
        if (messageIndex > index) statuses.delete(agentId);
      }
      for (const block of message.content) {
        if (block.type !== "toolCall" || block.toolName !== "subagent_spawn") continue;
        const input = block.input as { agent?: unknown; task?: unknown } | undefined;
        const agent = typeof input?.agent === "string" ? input.agent : "unknown";
        const task = typeof input?.task === "string" ? input.task : "";
        statuses.set(block.toolCallId, { id: block.toolCallId, agent, task, mode: "next-turn", state: "running" });
      }
    }
    if (message.role === "toolResult" && message.toolName === "subagent_spawn") {
      const text = contentText(message.content);
      const detailAgent = message.details as { agent?: { id?: unknown } } | undefined;
      const agentId = typeof detailAgent?.agent?.id === "string"
        ? detailAgent.agent.id
        : text.match(/\b(sa_[0-9a-f-]+)\b/i)?.[1];
      const status = statuses.get(message.toolCallId);
      if (!status) continue;
      statuses.delete(message.toolCallId);
      if (message.isError || !agentId) continue;
      status.id = agentId;
      status.mode = text.includes("auto-resume will request synthesis") ? "auto-resume" : "next-turn";
      statuses.set(status.id, status);
    }
    if (message.role === "toolResult" && message.toolName === "subagent_inspect") {
      const details = message.details as { runs?: Array<{ id?: unknown; state?: unknown }> } | undefined;
      for (const run of details?.runs ?? []) {
        if (typeof run.id !== "string" || (run.state !== "completed" && run.state !== "failed")) continue;
        const status = statuses.get(run.id);
        if (!status) continue;
        status.state = run.state;
        completedAt.set(run.id, messageIndex);
      }
    }
    for (const agentId of completedDetachedSubagentIds(message)) {
      const status = statuses.get(agentId);
      if (!status) continue;
      const details = message.role === "custom" ? message.details as { state?: unknown; completions?: Array<{ agentId?: unknown; state?: unknown }> } | undefined : undefined;
      const completionState = typeof details?.state === "string"
        ? details.state
        : details?.completions?.find((item) => item.agentId === agentId)?.state;
      status.state = completionState === "completed" ? "completed" : "failed";
      completedAt.set(agentId, messageIndex);
    }
  }
  return [...statuses.values()];
}

function deriveShadowReportStatus(_messages: AgentMessage[]): ShadowReportStatus[] {
  // shadow-mind 事件属于历史记录，不能据此推导当前仍在运行；运行态由实时事件/运行状态负责。
  return [];
}


function normalizeTodoItem(value: unknown): TodoItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const { id, subject } = item;
  const rawStatus = item.status;
  if (typeof id !== "number" || typeof subject !== "string" || typeof rawStatus !== "string") return null;
  // deleted 是墓碑状态，直接丢弃；其余未知状态按 pending 兜底。
  if (rawStatus === "deleted") return null;
  const status: TodoItemStatus =
    rawStatus === "in_progress" || rawStatus === "completed" ? rawStatus : "pending";
  const blockedBy = Array.isArray(item.blockedBy)
    ? item.blockedBy.filter((taskId): taskId is number => typeof taskId === "number")
    : undefined;
  return {
    id,
    subject,
    status,
    description: typeof item.description === "string" ? item.description : undefined,
    activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
    ...(blockedBy && blockedBy.length > 0 ? { blockedBy } : {}),
  };
}

// todo 工具是增量 action（create/update/delete/clear），但 harness 每次 toolResult 的
// details.tasks 都回传全量快照，因此最后一条有效结果即为当前列表，无需在前端重放 action。
export function deriveTodos(messages: AgentMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "toolResult" || message.toolName !== "todo") continue;
    const details = message.details as { tasks?: unknown } | undefined;
    if (!details || !Array.isArray(details.tasks)) continue;
    const todos: TodoItem[] = [];
    for (const task of details.tasks) {
      const normalized = normalizeTodoItem(task);
      if (normalized) todos.push(normalized);
    }
    return todos;
  }
  return [];
}

function normalizeQueuedMessages(q?: Partial<QueuedMessages> | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type { NoticeItem, NoticeType } from "@/lib/notice-state";

export type AskQuestionnaireOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskQuestionnaireQuestion = {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskQuestionnaireOption[];
};

export type AskQuestionnaireAnswer =
  | { kind: "options"; optionIndexes: number[] }
  | { kind: "custom"; text: string };

export type AskQuestionnaireState = {
  toolCallId: string;
  questions: AskQuestionnaireQuestion[];
  submitting: boolean;
  error?: string;
};

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" | "compact" | "openSideChat" };

export interface UseAgentSessionOptions {
  navigationKey: number;
  isNavigationActive: (key: number) => boolean;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  pendingNewSessionControl: PendingNewSessionControl;
  onPendingNewSessionEvent: (cwd: string, event: PendingNewSessionEvent) => void;
  onSessionCreated?: (session: SessionInfo, options?: { preserveDraft?: boolean }) => void;
  /** 发送途中已切走：会话照常创建，但不把用户拉回来。 */
  onSessionCreatedInBackground?: (session: SessionInfo) => void;
  // 新会话首次落盘或一轮运行结束后刷新侧栏列表。
  onSessionListRefresh?: (request: SessionListRefreshRequest) => void;
  onSessionForked?: (newSessionId: string) => void;
  onSessionEnded?: (sessionId: string) => void;
  /** 顶层工具调用结束；除只读工具外，它可能改动了文件（#1144）。 */
  onToolEnd?: (toolName: string) => void;
  /** `/side`: a side chat was forked from this session; open its tab. The
   *  prompt argument, if any, seeds the new chat's composer. */
  onSideSession?: (session: SessionInfo, prompt: string | null) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** 注册一个非 prompt 的启动动作，供系统面板按需读取系统提示词。 */
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  /** Registers the debug panel's reader of this page's stream and lease: it reads refs only, never a request. */
  onDebugSnapshotReaderChange?: (reader: (() => DebugClientSession) | null) => void;
  /** The page's translator, for the notices the hook writes itself. */
  t: (key: string, params?: TranslationParams) => string;
  onToolsLoaderChange?: (loader: (() => Promise<ToolEntry[]>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens Settings on a section; a bare `/mcp` the built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

// 父轮结束后，扩展可能异步注入一轮新的 agent run（例如后台子代理完成）。

// Session id -> user entry being edited. ChatWindow remounts per session, so a
// pending edit lives here as long as that session's in-memory draft does.
const pendingHistoryEdits = new Map<string, string>();

const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
// AgentSession 冷启动可能包含模型、扩展和资源初始化，5 秒不足以覆盖正常启动耗时。
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 15_000;
const NOTICE_EXIT_ANIMATION_MS = 180;

type EventStreamConnectionStatus = "connected" | "timeout" | "closed" | "startup_error";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: StreamEventSource;
  errorMessage?: string;
  retryable?: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">, message?: string, public readonly retryable = false) {
    super(message ?? (status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again."));
    this.name = "EventStreamConnectionError";
  }
}
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAskQuestionnaire(input: unknown): AskQuestionnaireQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length < 1) return null;

  const parsed: AskQuestionnaireQuestion[] = [];
  for (const value of questions) {
    if (!value || typeof value !== "object") return null;
    const question = value as Record<string, unknown>;
    if (typeof question.header !== "string" || typeof question.question !== "string" || !Array.isArray(question.options)) return null;
    const options: AskQuestionnaireOption[] = [];
    for (const valueOption of question.options) {
      if (!valueOption || typeof valueOption !== "object") return null;
      const option = valueOption as Record<string, unknown>;
      if (typeof option.label !== "string" || typeof option.description !== "string") return null;
      options.push({
        label: option.label,
        description: option.description,
        ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
      });
    }
    if (options.length < 2) return null;
    parsed.push({
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return parsed;
}


function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  replaceMessage: (message: UserMessage) => void;
  insertText: (text: string) => void;
  setText: (text: string) => void;
  pasteText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  prependDraft: (draft: ChatDraft) => void;
  addImages: (files: File[]) => void;
  clearAcceptedPrompt: () => void;
  prepareDraftKeyChange: (sourceKey: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}


type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    navigationKey, isNavigationActive, session, onSideSession, newSessionCwd, pendingNewSessionControl, onPendingNewSessionEvent, onSessionCreated, onSessionCreatedInBackground, onSessionListRefresh, onSessionForked, onSessionEnded, onToolEnd,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onToolsLoaderChange, onSessionStatsPanelOpen, onOpenSettings,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const pendingControlKind = pendingNewSessionControl.kind;
  const pendingSessionView = selectPendingNewSession(pendingNewSessionControl);
  const pendingShadowMindEnabled = pendingSessionView.desiredShadowMindEnabled;
  const creationSettingsLocked = pendingSessionView.busy;
  // 创建参数要在等待（切模、初始化）之后再取：等待期间草稿仍可改 Shadow 开关和工具档位，
  // 用等待之前捕获的那一份会让运行时按旧设置初始化。
  const pendingNewSessionControlRef = useRef(pendingNewSessionControl);
  pendingNewSessionControlRef.current = pendingNewSessionControl;
  // 挂载接管用的身份（有 runtime 就必须先连 SSE 再补读快照）；
  // 控制类 UI 的授权是另一个投影（runtimeSessionId），两者不要混用。
  const attachSessionId = pendingSessionView.transportSessionId;
  const { completion, beginRun, settleRun } = useRunCompletion();
  const lastRunSubagentsActiveRef = useRef(false);
  // The run whose prompt the server is known to have got: one of its events
  // (agent_start, prompt_done, queue_update, its user message) arrived, maybe
  // before its request failed. Later ones clear the unconfirmed record itself.
  const landedPromptRunIdRef = useRef<number | null>(null);
  const unconfirmedSendRef = useRef<UnconfirmedSend | null>(null);
  const markPromptLanded = useCallback(() => {
    landedPromptRunIdRef.current = promptRunIdRef.current;
    if (unconfirmedSendRef.current?.runId === promptRunIdRef.current) unconfirmedSendRef.current = null;
  }, []);
  // The context the newest session read found, and the order its request
  // started in: only a read started after the run settled can settle it.
  const sessionReadSeqRef = useRef(0);
  const lastReadContextRef = useRef<{ sid: string; seq: number; messages: AgentMessage[]; entryIds: string[] } | null>(null);
  const leaseDebugRef = useRef<Pick<DebugClientLease, "renewStartedAt" | "inFlightSince" | "requests" | "unanswered" | "errors" | "last">>({
    renewStartedAt: null, inFlightSince: null, requests: 0, unanswered: 0, errors: 0, last: null,
  });
  const [promptMissingCwd, setPromptMissingCwd] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<{ navigationKey: number; message: string } | null>(null);
  const sendError = submissionError?.navigationKey === navigationKey ? submissionError.message : null;
  // 服务端 agent_settled/prompt_done 的 aborted：任一客户端停止的运行都不算完成。
  const lastRunAbortedRef = useRef(false);

  const [contextModel, setContextModel] = useState<SessionContextSnapshot["model"]>(null);
  const [contextVersion, setContextVersion] = useState<string | null>(null);
  const [detailsState, setDetailsState] = useState<{ sid: string; value: SessionDetails } | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  // 外部写入把 /context 挡在外面时，队列里只存在服务器内存中的消息：错误页据此给出取回入口。
  const [blockedRecall, setBlockedRecall] = useState<QueuedMessages | null>(null);
  // 错误页属于外部写入：文件稳定后可以直接重试读取，不必刷新。
  const [externalWriteBlocked, setExternalWriteBlocked] = useState(false);
  // 已经取回、但上下文还没读成功：草稿只在页面内存里，这时刷新就真的丢了。
  const [recalledPending, setRecalledPending] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [branchTailEntryIds, setBranchTailEntryIds] = useState<string[]>();
  const branchTailEntryIdsRef = useRef(branchTailEntryIds);
  const messagesRef = useRef(messages);
  const entryIdsRef = useRef(entryIds);
  // 运行中追加的消息没有 entry id；重读文件时把它们的 key 交给同位置的 entry（lib/message-keys.ts），避免整轮消息重挂载。
  const [messageKeyAliases, setMessageKeyAliases] = useState<ReadonlyMap<string, string>>(() => new Map());
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  const [historyPage, setHistoryPage] = useState<HistoryPageState>(
    { sid: null, oldestEntryId: null, hasMore: false, turnsBefore: 0, loading: false, failed: false },
  );
  // 卸载时从 ref 读取最终已分页窗口，避免 mount effect 的闭包捕获首帧状态。
  const viewSnapshotRef = useRef({ leafId: activeLeafId, page: historyPage, model: contextModel, thinkingLevel: "off", totalActiveMs: 0 });
  // 仅正文订阅者处理增量，hook 自身不再因每帧文本更新而重渲。
  const [streamingStore] = useState(createStreamingStore);
  const dispatch = streamingStore.dispatch;
  const dispatchStreamBatch = useCallback((events: ClientAssistantMessageEvent[]) => {
    dispatch({ type: "delta_batch", events });
  }, [dispatch]);
  const streamScopeKey = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : null);
  const {
    enqueue: enqueueStreamDelta,
    flush: flushStreamDeltas,
    reset: resetStreamDeltas,
  } = useFrameBatchedStreamDispatch(dispatchStreamBatch, streamScopeKey);
  const [agentRunning, setAgentRunning] = useState(false);
  // 正在执行的扩展命令（提交原文）。它们不起模型回合，界面靠它显示「执行命令中：/review …」。
  const runningCommandsRef = useRef<string[]>([]);
  const [runningCommands, setRunningCommandsState] = useState<string[]>([]);
  const setRunningCommands = useCallback((next: string[]) => {
    const previous = runningCommandsRef.current;
    if (previous.length === next.length && previous.every((text, index) => text === next[index])) return;
    runningCommandsRef.current = next;
    setRunningCommandsState(next);
  }, []);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<PendingBash | null>(null);
  const [toolClocks, setToolClocks] = useState<ToolClocks>(NO_TOOL_CLOCKS);
  const endedSessionRef = useRef<string | null>(null);
  const { modelState: modelSelectionState, modelActions: modelSelectionActions } = useModelSelection();
  const missingCwd = promptMissingCwd ?? modelSelectionState.missingCwd;
  const {
    names: modelNames,
    list: modelList,
    error: modelError,
    scopeWarnings: modelScopeWarnings,
    dataDiagnostics: modelDataDiagnostics,
    thinkingLevels: modelThinkingLevels,
    thinkingLevelMaps: modelThinkingLevelMaps,
    newSessionModel,
    newSessionDefaultModel,
    thinkingLevel,
    newSessionDefaultThinkingLevel,
  } = modelSelectionState;
  const [fastEnabled, setFastEnabled] = useState(false);
  const [runtimeFastAvailable, setRuntimeFastAvailable] = useState<boolean | null>(null);
  const [fastPending, setFastPending] = useState(false);
  // 每个模型支持的档位（`provider:modelId` 键）：切模提交时要按目标模型限幅，创建入口再兜一次。
  const thinkingLevelsRef = useRef(modelThinkingLevels);
  thinkingLevelsRef.current = modelThinkingLevels;
  const [toolPreset, setToolPreset] = useState<ToolPreset>(CONFIGURED_TOOL_PRESET);
  const [customToolNames, setCustomToolNames] = useState<string[] | null>(null);
  /**
   * 草稿的最新一份设置：渲染无关的镜像优先（跨实例、跨切走再回来），没有登记过才退回本实例
   * 的 props。直接打开 `?cwd=` 时没有任何事件派发过，镜像还是空的，这条回退就是那次的第一份。
   */
  const currentDraftControl = useCallback((): PendingNewSessionControl => (
    (newSessionCwd ? latestPendingNewSessionControl(newSessionCwd) : null) ?? pendingNewSessionControlRef.current
  ), [newSessionCwd]);
  // 等待切模/初始化期间工具档位仍可修改：创建请求要在等完之后按最新选择取工具名单。
  // 读草稿自己记下的那一份（挂载时把当时显示的档位也记进去），浏览器偏好只用来初始化——
  // 偏好是整台浏览器共用的一份，别的标签页改它、或者写入被拒（隐私模式、配额）时，
  // 输入框显示的档位和创建请求用的名单就会分叉。
  const currentNewSessionToolNames = useCallback(() => {
    const control = currentDraftControl();
    const draftTools = "tools" in control ? control.tools : null;
    const preset = draftTools?.preset ?? getPreferredToolPreset();
    const custom = draftTools ? draftTools.custom : getPreferredCustomTools();
    return custom ?? getToolNamesForPreset(preset);
  }, [currentDraftControl]);
  // 工具切换还没有落地：这段时间里候选名单还是旧的，再点一次会用它算出「只取消了一个工具」的请求。
  const [toolSelectionPending, setToolSelectionPending] = useState(false);
  const [activeToolNames, setActiveToolNames] = useState<string[] | undefined>();
  // 会话文件里钉死的内置工具名单；null 表示跟随 settings.json（configured）。只用于解释
  // "设置里开着、本会话却没有"的工具（例如扩展把 edit 换掉了），不决定控件显示哪一档。
  const [pinnedToolNames, setPinnedToolNames] = useState<string[] | null>(null);
  // 没有存活运行时时（刚打开一个旧会话）读不到工具名单：此时不给预设标签，免得显示
  // 一个初始值冒充用户的选择。新会话自带默认/已存偏好，一开始就是已知；旧会话需等 loadTools 或用户切换。
  const [toolSelectionKnown, setToolSelectionKnown] = useState(() => isNew);
  // Every available model, fetched only when the selector switches to "all" or the
  // shown model is outside the scope; null until then and after each loadModels.
  const [allModelList, setAllModelList] = useState<ModelEntry[] | null>(null);
  const allModelsLoadRef = useRef<object | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  // Active time read from the live state, with the session it belongs to: the
  // panel's snapshot is older than the transcript on screen, and this is what
  // keeps the value current while a run appends entries (#1334).
  const [liveTotalActiveMs, setLiveTotalActiveMs] = useState<{ sessionId: string; value: number } | null>(null);
  const contextUsageRequestIdRef = useRef(0);
  // Highest request id whose reply was applied. A reply applies only when it
  // is newer, so a failed newer read never discards an older good one.
  const contextUsageAppliedIdRef = useRef(0);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const sessionHookMountedRef = useRef(true);
  useEffect(() => {
    sessionHookMountedRef.current = true;
    return () => { sessionHookMountedRef.current = false; };
  }, []);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [sessionTotalActiveMs, setSessionTotalActiveMs] = useState(0);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  // 同步弹窗状态：settlement 判定需要知道当前是否有 dialog 在等用户输入
  const extensionDialogRef = useRef<ExtensionUiDialogRequest | null>(null);
  const [askQuestionnaire, setAskQuestionnaire] = useState<AskQuestionnaireState | null>(null);
  const askQuestionnaireRef = useRef<AskQuestionnaireState | null>(null);
  const askQuestionnaireRequestQueueRef = useRef<ExtensionUiDialogRequest[]>([]);
  const askQuestionnaireRequestWaiterRef = useRef<{
    accept: (request: ExtensionUiDialogRequest) => void;
    cancel: () => void;
  } | null>(null);
  const askQuestionnaireRequestIdsRef = useRef(new Set<string>());
  // 最后一题已回送但工具尚未结束时，重连重放不能重新创建同一问卷。
  const submittedAskToolCallIdsRef = useRef(new Set<string>());
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  // 队列显示的镜像：错误页没有输入框，判断「有没有可取回的消息」要读当前显示的这一份，
  // 而不是某次加载的预读（它可能已经被建连补读或实时事件取代）。
  const queuedMessagesRef = useRef<QueuedMessages>({ steering: [], followUp: [] });
  /**
   * 队列显示的唯一写入口：界面状态、镜像与错误页的「移回」入口一起更新。入口一起写是必须的：
   * `/context` 先返回 500、带待取回消息的 `/state` 随后才回来时，只更新界面的话错误页永远拿不到
   * 入口（它没有输入框，读的就是 `blockedRecall`）。走到这里的写入都已按读取序号与队列代次校验。
   */
  const updateQueuedMessages = useCallback((next: QueuedMessages) => {
    queuedMessagesRef.current = next;
    setQueuedMessages(next);
    setBlockedRecall(next.steering.length > 0 || next.followUp.length > 0 ? next : null);
  }, []);
  const detachedSubagentStatuses = useMemo(() => deriveDetachedSubagentStatuses(messages), [messages]);
  const shadowReportStatuses = useMemo(() => deriveShadowReportStatus(messages), [messages]);
  const todos = useMemo(() => deriveTodos(messages), [messages]);


  const eventSourceRef = useRef<StreamEventSource | null>(null);
  const eventStreamConnectionRef = useRef<{
    sessionId: string; source: StreamEventSource;
    promise: Promise<EventStreamConnectionResult>; settled: boolean; recovering: boolean; cancel?: () => void;
  } | null>(null);
  // 超限载荷不会因重连变小；发送失败清理也不能解除，只有离开/重新打开会话才重试。
  const eventStreamStartupFailureRef = useRef<{ sessionId: string; result: EventStreamConnectionResult } | null>(null);
  // 一次恢复跨越底层重连甚至来源重建；同一会话只维护一条可重试错误通知。
  const eventStreamRetryNoticeRef = useRef<{ sessionId: string; id: string; message: string } | null>(null);
  useEffect(() => {
    if (eventStreamStartupFailureRef.current?.sessionId !== (session?.id ?? attachSessionId)) {
      eventStreamStartupFailureRef.current = null;
    }
    if (eventStreamRetryNoticeRef.current?.sessionId !== (session?.id ?? attachSessionId)) {
      eventStreamRetryNoticeRef.current = null;
    }
  }, [session?.id, attachSessionId, newSessionCwd]);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  // detached 子代理可能跨越多个父轮，必须按 agentId 保持到对应 completion 到达。
  const pendingDetachedSubagentIdsRef = useRef(new Set<string>());
  const sessionIdRef = useRef<string | null>(session?.id ?? attachSessionId);
  const contextVersionRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);
  useEffect(() => {
    if (!newSessionCwd) return;
    if (
      pendingControlKind === "materialized"
      || pendingControlKind === "initialization-failed"
      || pendingControlKind === "materialization-failed"
    ) {
      releaseNewSessionMaterialization(newSessionCwd);
    }
  }, [newSessionCwd, pendingControlKind]);
  const details = session
    && detailsState?.sid === session.id
    && detailsState.value.version === contextVersion
    ? detailsState.value
    : null;
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  /** The session read under way when a `!` result was held for the run's end (`PendingBash`). */
  const deferredBashReadSeqRef = useRef(0);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const isFirstNoticeShowing = useRef(createShownNotices()).current;
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<boolean> | undefined>(undefined);
  const [scrollPositionRequest, setScrollPositionRequest] = useState<ChatScrollPositionRequest | null>(null);
  const requestScrollPosition = useCallback((position: ChatScrollPosition) => {
    setScrollPositionRequest((current) => ({
      generation: (current?.generation ?? 0) + 1,
      position,
    }));
  }, []);
  const handleNavigateRef = useRef<((entryId: string) => Promise<boolean>) | undefined>(undefined);
  // The command list as last loaded, and the get_commands request under way, if
  // any. A bare /mcp reads them to tell whose /mcp it is (handleBuiltinSlashCommand).
  // The generation moves on with every request and every clear, and only a request
  // still current writes its answer: one that set_tools outdated (or a newer request)
  // would otherwise put back the list of a session that is no longer there.
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const slashCommandsGenerationRef = useRef(0);
  const newSessionPromotedRef = useRef(false);
  const initialPendingSettings = "model" in pendingNewSessionControl ? pendingNewSessionControl : null;
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(initialPendingSettings?.model ?? null);
  // 草稿记下的档位要按来源放回对应的 ref：用户挑的进手动覆盖，切模型解析出来的进推荐值——
  // 都塞进手动覆盖会让自动推荐在重新打开草稿后变成"用户显式选的档位"。
  const initialThinkingLevel = initialPendingSettings?.thinkingLevel === "auto"
    ? null
    : initialPendingSettings?.thinkingLevel ?? null;
  const initialLevelIsManual = initialPendingSettings?.thinkingLevelSource === "manual";
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(
    initialLevelIsManual ? initialThinkingLevel : null,
  );
  // 用户主动选了 `auto`（交给服务端定档）：目录刷新不该再按默认模型算一遍推荐显示出来，
  // 否则输入框显示一个创建请求不会带上的档位。
  const explicitAutoThinkingRef = useRef(
    initialPendingSettings?.thinkingLevel === "auto" && initialPendingSettings.thinkingLevelSource === "manual",
  );
  const recommendedThinkingLevelRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(
    initialLevelIsManual ? null : initialThinkingLevel,
  );
  // 草稿切模型的在途任务：档位要等推荐返回才定，首条消息和其它创建入口必须先等它。
  const draftModelSwitchRef = useRef<{ version: number; task: Promise<DraftModelSelection | null> } | null>(null);
  /** 把一份草稿选择写进本实例的 refs 和选择器；三者都没变就不动，免得反复触发状态更新。 */
  const applyDraftSelection = useCallback((selection: DraftModelSelection) => {
    const currentModel = newSessionModelOverrideRef.current;
    const currentLevel = thinkingLevelOverrideRef.current ?? recommendedThinkingLevelRef.current ?? "auto";
    const currentSource = thinkingLevelOverrideRef.current === null ? "auto" : "manual";
    if (currentModel?.provider === selection.model.provider
      && currentModel.modelId === selection.model.modelId
      && currentLevel === selection.thinkingLevel
      && currentSource === selection.thinkingLevelSource) {
      return;
    }
    newSessionModelOverrideRef.current = selection.model;
    if (selection.thinkingLevel !== "auto") explicitAutoThinkingRef.current = false;
    const level = selection.thinkingLevel === "auto" ? null : selection.thinkingLevel;
    if (selection.thinkingLevelSource === "manual") {
      thinkingLevelOverrideRef.current = level;
      recommendedThinkingLevelRef.current = null;
    } else {
      thinkingLevelOverrideRef.current = null;
      recommendedThinkingLevelRef.current = level;
    }
    void modelSelectionActions.selectNewSessionModel(selection.model, { preserveLevel: true });
    modelSelectionActions.setThinkingLevel(selection.thinkingLevel);
    setPendingModel(selection.model);
  }, [modelSelectionActions]);
  useEffect(() => {
    if (!isNew || !initialPendingSettings) return;
    if (initialPendingSettings.model) {
      void modelSelectionActions.selectNewSessionModel(initialPendingSettings.model, { preserveLevel: true });
      setPendingModel(initialPendingSettings.model);
    }
    modelSelectionActions.setThinkingLevel(initialPendingSettings.thinkingLevel);
  // 仅在该 cwd 的新会话组件挂载时恢复一次，后续变更由交互处理器同步。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 草稿状态也可能被另一个实例改写：切模型时切走再回来会重建组件，旧的实例在后台解析完档位后
  // 才把模型和档位一起写进状态。没有在途切换时跟进它，否则这个实例的创建请求会用旧模型，
  // 和状态机、界面显示的选择对不上。
  useEffect(() => {
    if (!isNew || !initialPendingSettings?.model || draftModelSwitchRef.current) return;
    if (newSessionCwd && getDraftModelSwitch(newSessionCwd)) return;
    applyDraftSelection({
      model: initialPendingSettings.model,
      thinkingLevel: initialPendingSettings.thinkingLevel,
      thinkingLevelSource: initialPendingSettings.thinkingLevelSource,
    });
  }, [applyDraftSelection, initialPendingSettings, isNew, newSessionCwd]);
  // 手动选中的 `auto` 也要跟着草稿恢复：重建出来的实例若从 false 起步，目录加载会把历史推荐
  // 显示出来，而草稿仍写着手动 `auto`（创建请求省略档位），界面和请求又对不上。
  useEffect(() => {
    if (!isNew || !initialPendingSettings) return;
    explicitAutoThinkingRef.current = initialPendingSettings.thinkingLevel === "auto"
      && initialPendingSettings.thinkingLevelSource === "manual";
  }, [initialPendingSettings, isNew]);
  /**
   * 等草稿切模落地。除了本实例的在途任务，还要看同 cwd 别处登记的那一次：切走再回来会换一个
   * 实例，旧实例的 ref 已经不存在，只查 ref 就会让首条消息绕过还在解析的切换。
   * 拿到的选择直接写进本实例，因为状态更新可能还没进入这次 render。
   */
  const awaitDraftModelSwitch = useCallback(async () => {
    // cwd 已是草稿身份的一部分，不能拿组件残留任务与另一 cwd 的版本号比较。
    const current = () => newSessionCwd ? getDraftModelSwitch(newSessionCwd) : draftModelSwitchRef.current;
    // 每一轮都在结算前被下一轮取代时不能提前返回：那样创建入口会带着还没结算的那次选择去
    // 创建，创建随即进入 materializing，它后来的 SET_MODEL 会被状态机丢掉，首条消息用的还是
    // 旧模型。循环不设次数上限；每轮等待任务结算或共享版本更新，旧请求永久挂起也能被新选择唤醒。
    let awaited: Promise<DraftModelSelection | null> | null = null;
    for (;;) {
      const pending = current();
      // 同一份任务又回来了（结算与清登记之间的空档）：没有更新的等待对象，就此结束。
      if (!pending || pending.task === awaited) return;
      awaited = pending.task;
      const selection = newSessionCwd
        ? await waitForDraftModelSwitchTask(newSessionCwd, pending)
        : await pending.task.catch(() => null);
      // 版本对不上说明同一草稿上又起了新的切换：这一份已经作废，不能拿它覆盖后来的选择。
      const latest = !newSessionCwd || isLatestDraftModelSwitch(newSessionCwd, pending.version);
      if (selection && latest) {
        applyDraftSelection(selection);
        return;
      }
      // 已经作废：丢掉自己的 ref 再等下一轮，否则会一遍遍等同一份过期结果。
      if (draftModelSwitchRef.current?.task === pending.task) draftModelSwitchRef.current = null;
    }
  }, [applyDraftSelection, newSessionCwd]);
  /**
   * 创建参数取草稿的最新一份。等待切模或初始化期间，用户可能已经切走再回来、在另一个实例里
   * 改了模型、档位和 Shadow 开关：本实例的 props 与 refs 都停在离开那一刻，照它们创建就会
   * 用上已经被取代的旧模型。状态机镜像由事件派发处同步写入，与哪个实例还挂着无关。
   */
  const currentNewSessionSettings = useCallback(() => {
    const control = currentDraftControl();
    const settings = "model" in control ? control : null;
    const view = selectPendingNewSession(control);
    const model = settings?.model ?? newSessionModelOverrideRef.current ?? null;
    const level = settings
      ? (settings.thinkingLevel === "auto" ? null : settings.thinkingLevel)
      : (thinkingLevelOverrideRef.current ?? recommendedThinkingLevelRef.current);
    // 限幅按真正被创建的那个模型来：界面在切模等待期间还按切之前的模型给选项，
    // 用户可能选了一个目标模型做不到的档位。
    const target = model ?? newSessionModel ?? newSessionDefaultModel ?? null;
    const supported = target ? thinkingLevelsRef.current[`${target.provider}:${target.modelId}`] ?? null : null;
    const owner = settings?.recommendationModel;
    const recommendationMatches = !owner || (target?.provider === owner.provider && target.modelId === owner.modelId);
    return {
      control,
      view,
      model,
      thinkingLevel: recommendationMatches && level ? clampThinkingLevelToSupported(level, supported) : null,
      // 自动推荐与手动选择都用于这个会话，但只有手动选择才是"新的默认档位"。
      thinkingLevelExplicit: settings ? settings.thinkingLevelSource === "manual" : thinkingLevelOverrideRef.current !== null,
      thinkingLevelModel: settings?.thinkingLevelSource === "auto" ? owner ?? model ?? target ?? undefined : undefined,
      shadowMindEnabled: view.desiredShadowMindEnabled,
    };
  }, [currentDraftControl, newSessionModel, newSessionDefaultModel]);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  // 流式期间本地已收齐的消息条数（在 message_end 的 setMessages updater 内同步），
  // 用于 agent_end 时判断是否丢帧、能否跳过全量 context 重载。
  const lastStreamedMessageCountRef = useRef(0);
  // 统一 reconciliation 定义较晚，通过 ref 供扩展 UI 回调触发，避免再维护独立轮询器。
  const reconcileAgentStateRef = useRef<((sid: string, runId?: number) => Promise<void>) | null>(null);
  const reconcileRequestGenerationRef = useRef(0);
  // context 与后台 details/state 使用独立取消域，避免并行请求互相 abort。
  const contextLoaderRef = useRef(new LatestContextLoader());
  const contextRefreshSchedulerRef = useRef(new SessionContextRefreshScheduler());
  const shadowLifecycleRef = useRef(new ShadowLifecycleCoordinator());
  const detailsRequestRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const backfillRequestRef = useRef<{ sid: string; generation: number; controller: AbortController | null }>({
    sid: "",
    generation: 0,
    controller: null,
  });
  const runtimeStateRequestRef = useRef<AbortController | null>(null);
  const navigationSequenceRef = useRef(0);
  const navigationGenerationRef = useRef(new Map<string, number>());
  const navigationChainRef = useRef(new Map<string, Promise<void>>());

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType; expanded?: boolean }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
        expanded: notice.expanded,
      },
      now: Date.now(),
    });
  }, []);
  const addShadowErrorNotice = useCallback((message: string) => {
    addNotice({ type: "error", message });
  }, [addNotice]);
  const handlePendingShadowMindChange = useCallback((enabled: boolean) => {
    if (newSessionCwd) onPendingNewSessionEvent(newSessionCwd, { type: "SET_SHADOW", enabled });
  }, [newSessionCwd, onPendingNewSessionEvent]);
  const shadowSessionSetting = useShadowSessionSetting({
    sessionIdRef,
    addErrorNotice: addShadowErrorNotice,
    staged: isNew && pendingSessionView.shadowMode === "staged" ? {
      enabled: pendingShadowMindEnabled,
      pending: pendingSessionView.shadowPending,
      onChange: handlePendingShadowMindChange,
    } : null,
  });
  const {
    enabled: shadowMindEnabled,
    available: shadowMindAvailable,
    pending: shadowMindTogglePending,
    applyRuntimeState: applyShadowRuntimeState,
    consumeEntry: consumeShadowEntry,
    restoreSnapshot: restoreShadowSnapshot,
    runSlashCommand: runShadowSlashCommand,
    toggle: handleShadowMindToggle,
  } = shadowSessionSetting;

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  useEffect(() => {
    if (!isNew || sessionIdRef.current) return;
    // 草稿自己的记录优先：那是这个 cwd 的草稿真正选过的档位；浏览器偏好只是新草稿的默认值，
    // 别的标签页随时可能改它。
    const control = currentDraftControl();
    const draftTools = "tools" in control ? control.tools ?? null : null;
    const preset = draftTools?.preset ?? getPreferredToolPreset();
    const custom = draftTools ? draftTools.custom : getPreferredCustomTools();
    setToolPresetState(preset);
    setCustomToolNames(custom);
    // 记下这一刻真正显示的名单：创建请求之后按它发。只读当前偏好会让别的标签页改偏好后
    // 这里显示一档、创建用另一档。
    if (!draftTools && newSessionCwd) {
      onPendingNewSessionEvent(newSessionCwd, { type: "SET_TOOLS", tools: { preset, custom } });
    }
    // 新会话的档位来自浏览器里记住的选择，本身就是"已知"。
    setToolSelectionKnown(true);
    // worktree 切换仅更新 cwd，不重挂载；目标草稿也必须在此恢复或初始化。
  }, [isNew, newSessionCwd, currentDraftControl, onPendingNewSessionEvent, setToolPresetState]);

  // 工具档位也可能是在另一个实例里改的（切走再回来会重建组件）：跟着草稿走，否则输入框
  // 显示一档、创建请求按另一档。
  useEffect(() => {
    if (!isNew) return;
    const draftTools = initialPendingSettings?.tools;
    if (!draftTools) return;
    const sameCustom = draftTools.custom === customToolNames
      || (draftTools.custom !== null && customToolNames !== null
        && draftTools.custom.length === customToolNames.length
        && draftTools.custom.every((name, index) => name === customToolNames[index]));
    if (draftTools.preset === toolPreset && sameCustom) return;
    setToolPresetState(draftTools.preset);
    setCustomToolNames(draftTools.custom);
  }, [customToolNames, initialPendingSettings?.tools, isNew, setToolPresetState, toolPreset]);

  const currentModel = currentModelOverride ?? contextModel ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;
  const displayModelFastAvailable = displayModel
    ? modelList.find((model) => model.provider === displayModel.provider && model.id === displayModel.modelId)?.fastAvailable ?? false
    : false;

  // Editing a past message only prefills the composer; the branch moves when it is sent,
  // so cancelling or reloading never hides the rest of the conversation.
  const [editEntryId, setEditEntryId] = useState(() => {
    const sid = session?.id;
    if (sid && !getDraft(sid)) pendingHistoryEdits.delete(sid);
    return (sid && pendingHistoryEdits.get(sid)) || null;
  });
  const setEdit = useCallback((entryId: string | null) => {
    if (!session?.id) return;
    if (entryId) pendingHistoryEdits.set(session.id, entryId);
    else pendingHistoryEdits.delete(session.id);
    setEditEntryId(entryId);
  }, [session?.id]);
  const handleEditContent = useCallback((message: UserMessage, entryId: string) => {
    if (!session?.id) return;
    opts.chatInputRef?.current?.replaceMessage(message);
    setEdit(entryId);
  }, [opts.chatInputRef, session?.id, setEdit]);
  const cancelEdit = useCallback(() => setEdit(null), [setEdit]);

  const sessionStats = useMemo(() => {
    // Active time is a monotone sum over the session's entries, so of the two
    // readings the larger one is the newer one (#1334).
    const liveActiveMs = liveTotalActiveMs && liveTotalActiveMs.sessionId === session?.id ? liveTotalActiveMs.value : 0;
    const totalActiveMs = Math.max(sessionTotalActiveMs, liveActiveMs);
    if (sessionStatsOverride) return {
      ...sessionStatsOverride,
      ...(totalActiveMs > 0 ? { totalActiveMs } : {}),
    };
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: details?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
      ...(totalActiveMs > 0 ? { totalActiveMs } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, liveTotalActiveMs, details?.filePath, session?.id, session?.name, sessionTotalActiveMs]);

  // 只让已成功读取的较新用量覆盖旧值；失败的新请求不影响仍在等待的旧请求。
  const applyContextUsage = useCallback((sid: string, runId: number, requestId: number, usage: AgentRuntimeState["contextUsage"]) => {
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || promptRunIdRef.current !== runId
      || requestId <= contextUsageAppliedIdRef.current) return;
    contextUsageAppliedIdRef.current = requestId;
    setContextUsage(usage);
  }, []);

  const refreshContextUsage = useCallback(async (sid: string) => {
    const runId = promptRunIdRef.current;
    const requestId = ++contextUsageRequestIdRef.current;
    try {
      const response = await fetch(agentStatusUrl(sid));
      if (!response.ok) return;
      const snapshot = await response.json() as AgentRuntimeSnapshot;
      if (snapshot.state) applyContextUsage(sid, runId, requestId, snapshot.state.contextUsage);
    } catch (error) {
      console.warn("刷新上下文用量失败", error);
    }
  }, [applyContextUsage]);

  /** 所有服务端运行状态都通过这一入口投影，避免挂载、reload、reconcile 字段漂移。 */
  const applyRuntimeState = useCallback((
    state: AgentRuntimeState | undefined,
    usageRead?: { sid: string; runId: number; requestId: number },
    // 队列、压缩、思考强度及扩展 UI 各自校验，防止迟到快照覆盖较新的实时事件。
    options: {
      queue?: boolean; compaction?: boolean; thinking?: boolean;
      extensionStatuses?: boolean; extensionWidgets?: boolean;
      extensionStatusesRevision?: number; extensionWidgetsRevision?: number;
    } = {},
  ) => {
    if (options.compaction !== false) setIsCompacting(state?.isCompacting ?? false);
    if (options.queue !== false) updateQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
    setRunningCommands(state?.runningCommands ?? []);
    if (!state) {
      setFastEnabled(false);
      setRuntimeFastAvailable(null);
      applyShadowRuntimeState(undefined);
      return;
    }
    if (usageRead) applyContextUsage(usageRead.sid, usageRead.runId, usageRead.requestId, state.contextUsage);
    else setContextUsage(state.contextUsage);
    // 状态读取不带系统提示词（agentStatusUrl）：缺失不代表提示词被清空。
    if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt);
    if (typeof state.totalActiveMs === "number" && sessionIdRef.current) {
      setLiveTotalActiveMs({ sessionId: sessionIdRef.current, value: state.totalActiveMs });
    }
    applyShadowRuntimeState(state);
    if (options.thinking !== false) {
      // 运行态的档位是「服务端此刻真正在用的那一档」：记下这个会话已经拿到过它，
      // 之后的上下文档位（可能取样更早、只是回来得更晚）就不再覆盖它。
      if (typeof state.thinkingLevel === "string" && sessionIdRef.current) {
        runtimeThinkingLevelSessionRef.current = sessionIdRef.current;
      }
      modelSelectionActions.setThinkingLevel(state.thinkingLevel);
    }
    setFastEnabled(state.fastEnabled);
    setRuntimeFastAvailable(state.fastAvailable);
    const capturePendingRevisions = (revisions: Map<string, number>, readRevision: number | undefined) => {
      // 旧读取已由序号挡住；只保留本次请求之后的事件，避免历史删除键一直积累。
      if (readRevision !== undefined) {
        for (const [key, revision] of revisions) if (revision <= readRevision) revisions.delete(key);
      }
      // React 可延后执行更新，固定剩余记录的副本，后续回收不会改动已经排队的更新。
      return new Map(revisions);
    };
    if (options.extensionStatuses !== false) {
      const revisions = capturePendingRevisions(extensionStatusKeyRevisionsRef.current, options.extensionStatusesRevision);
      setExtensionStatuses(prev => mergeExtensionUiSnapshot(prev, state.extensionStatuses, revisions, options.extensionStatusesRevision));
    }
    if (options.extensionWidgets !== false) {
      const revisions = capturePendingRevisions(extensionWidgetKeyRevisionsRef.current, options.extensionWidgetsRevision);
      const widgets = filterVisibleExtensionWidgets(state.extensionWidgets);
      setExtensionWidgets(prev => mergeExtensionUiSnapshot(prev, widgets, revisions, options.extensionWidgetsRevision));
    }
    // 绑定完成事件可能早于监听建立；状态轮询也要按同一协议投影收敛（失败不能当成就绪）。
    if (newSessionCwd && sessionIdRef.current) {
      const binding = projectExtensionBinding(state);
      if (binding === "bound") {
        onPendingNewSessionEvent(newSessionCwd, { type: "EXTENSIONS_READY", sessionId: sessionIdRef.current });
      } else if (binding === "failed") {
        onPendingNewSessionEvent(newSessionCwd, {
          type: "POST_START_FAIL",
          sessionId: sessionIdRef.current,
          error: state.extensionsError ?? "扩展初始化失败",
        });
      }
    }
  }, [applyContextUsage, applyShadowRuntimeState, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent, setRunningCommands, updateQueuedMessages]);

  /**
   * 一次运行态读取的坐标：发起时的序号及各字段事件版本。较新的队列、压缩、扩展 UI
   * 事件到达后，迟到的快照不得盖回旧字段；读取顺序也不能倒退。
   */
  const beginRuntimeRead = useCallback((): RuntimeRead => ({
    seq: ++runtimeReadSeqRef.current,
    queueGeneration: queueStateGenerationRef.current,
    compactionEpoch: compactionEpochRef.current,
    thinkingRevision: thinkingChoiceRevisionRef.current,
    extensionStatusesRevision: extensionStatusesRevisionRef.current,
    extensionWidgetsRevision: extensionWidgetsRevisionRef.current,
  }), []);

  /** 按读取坐标投影一份运行态快照：凡是比它新的实时状态都不覆盖。 */
  const applyRuntimeSnapshot = useCallback((read: RuntimeRead, state: AgentRuntimeState | undefined, usageRead?: { sid: string; runId: number; requestId: number }): { thinking: boolean } => {
    const newest = read.seq > lastAppliedRuntimeSeqRef.current;
    // 队列也按读取序号校验：断线期间错过的 `queue_update` 不会推进代次，只比代次的话
    // 「取到空队列、回来时另一份快照已经显示了新队列」的响应仍然会把队列行清掉。
    const queueAdopted = read.seq > lastAppliedQueueSeqRef.current
      && queueStateGenerationRef.current === read.queueGeneration;
    const thinkingAdopted = read.seq > lastAppliedThinkingSeqRef.current
      && read.thinkingRevision === thinkingChoiceRevisionRef.current;
    applyRuntimeState(state, usageRead, {
      queue: queueAdopted,
      compaction: compactionEpochRef.current === read.compactionEpoch && newest,
      thinking: thinkingAdopted,
      extensionStatuses: newest,
      extensionWidgets: newest,
      extensionStatusesRevision: read.extensionStatusesRevision,
      extensionWidgetsRevision: read.extensionWidgetsRevision,
    });
    if (queueAdopted) lastAppliedQueueSeqRef.current = read.seq;
    if (thinkingAdopted) lastAppliedThinkingSeqRef.current = read.seq;
    if (newest) {
      // 这份快照说「有没有主回合在跑」：流式输出、等待模型，或者正在执行的扩展命令。
      runtimeBusySnapshotRef.current = state !== undefined
        && (state.isStreaming === true || state.isPromptRunning === true || (state.runningCommands?.length ?? 0) > 0);
      lastAppliedRuntimeSeqRef.current = read.seq;
    }
    // 调用方需要知道档位这份快照到底算不算数：被跳过的旧档位不能再写回草稿或选择器。
    return { thinking: thinkingAdopted };
  }, [applyRuntimeState]);

  // extensions-binding 是等待态：绑定完成事件可能错过（例如切走期间绑定已完成），
  // 因此在这个状态里兜底轮询运行时状态，由同一协议投影收敛到就绪或失败。
  const bindingPollSessionId = isNew && pendingSessionView.extensionsPending ? pendingSessionView.transportSessionId : null;
  const bindingPollDeadline = useCallback(() => {
    const sid = bindingPollSessionId;
    if (!newSessionCwd || !sid) return;
    // 总期限到期：收敛到可重试的失败态并保留同一 runtime 身份，不能永久停在初始化中。
    onPendingNewSessionEvent(newSessionCwd, {
      type: "POST_START_FAIL",
      sessionId: sid,
      error: `扩展初始化超过 ${Math.round(SESSION_BINDING_DEADLINE_MS / 1000)}s 仍未完成`,
    });
  }, [bindingPollSessionId, newSessionCwd, onPendingNewSessionEvent]);
  useSessionBindingPoll({
    sessionId: bindingPollSessionId,
    enabled: bindingPollSessionId !== null,
    beforeRead: () => { bindingPollReadRef.current = beginRuntimeRead(); },
    onSnapshot: (snapshot) => {
      const read = bindingPollReadRef.current;
      if (snapshot.state && read && sessionIdRef.current === bindingPollSessionId) {
        applyRuntimeSnapshot(read, snapshot.state);
      }
    },
    deadlineMs: SESSION_BINDING_DEADLINE_MS,
    onDeadline: bindingPollDeadline,
  });

  /** context 的所有派生状态统一原子提交，挂载加载和分支导航不得各维护一份字段列表。 */
  const commitContextSnapshot = useCallback((
    sid: string,
    snapshot: SessionContextSnapshot,
    leafId: string | null,
    options: { preserveScroll?: boolean; focusCompaction?: boolean } = {},
  ): boolean => {
    if (sessionIdRef.current !== sid) return false;
    backfillRequestRef.current.controller?.abort();
    backfillRequestRef.current = {
      sid,
      generation: backfillRequestRef.current.generation + 1,
      controller: null,
    };
    restoreShadowSnapshot(sid, snapshot.shadowMindEnabled);
    viewSnapshotRef.current.thinkingLevel = snapshot.thinkingLevel;
    setContextModel(snapshot.model);
    contextVersionRef.current = snapshot.version;
    setContextVersion(snapshot.version);
    setSessionTotalActiveMs(snapshot.totalActiveMs ?? 0);
    setActiveLeafId(leafId);
    pendingDetachedSubagentIdsRef.current = pendingDetachedSubagentIds(snapshot.messages);
    if (!options.preserveScroll) {
      // 手动压缩定位本次摘要，不能沿用普通加载时的末条消息定位。
      const compactionPosition = options.focusCompaction
        ? getCompactionScrollPosition(snapshot.messages, snapshot.entryIds)
        : null;
      requestScrollPosition(compactionPosition ?? "initial");
    }
    const previousView = { messages: messagesRef.current, entryIds: entryIdsRef.current };
    const nextView = { messages: snapshot.messages, entryIds: snapshot.entryIds };
    setMessageKeyAliases((aliases) => carryMessageKeys({ ...previousView, aliases }, nextView));
    setMessages(snapshot.messages);
    setEntryIds(snapshot.entryIds);
    setBranchTailEntryIds(snapshot.branchTailEntryIds);
    branchTailEntryIdsRef.current = snapshot.branchTailEntryIds;
    messagesRef.current = snapshot.messages;
    entryIdsRef.current = snapshot.entryIds;
    setHistoryPage({
      sid,
      oldestEntryId: snapshot.oldestEntryId,
      hasMore: snapshot.hasMore,
      turnsBefore: snapshot.turnsBefore,
      loading: false,
      failed: false,
    });
    setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
    setError(null);
    setBlockedRecall(null);
    setExternalWriteBlocked(false);
    setRecalledPending(false);
    setRecallError(null);
    clearDraftRestorePending(sid);
    // 上下文的档位只作回退：会话已经读到运行态档位时，上下文这份可能更旧（取样更早却更晚返回）。
    if (snapshot.thinkingLevel && snapshot.thinkingLevel !== "off"
      && runtimeThinkingLevelSessionRef.current !== sid) {
      modelSelectionActions.setThinkingLevel(snapshot.thinkingLevel);
    }
    setLoading(false);
    return true;
  }, [modelSelectionActions, requestScrollPosition, restoreShadowSnapshot]);

  viewSnapshotRef.current.leafId = activeLeafId;
  viewSnapshotRef.current.page = historyPage;
  viewSnapshotRef.current.model = contextModel;
  viewSnapshotRef.current.totalActiveMs = sessionTotalActiveMs;

  /** 按活动分支游标向前加载一页；请求串行且只允许提交到发起时的会话和边界。 */
  const loadEarlierMessages = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    const page = historyPage;
    if (!sid || page.sid !== sid || !page.hasMore || page.loading || !page.oldestEntryId) return false;

    const before = page.oldestEntryId;
    const generation = backfillRequestRef.current.generation + 1;
    backfillRequestRef.current.controller?.abort();
    const controller = new AbortController();
    backfillRequestRef.current = { sid, generation, controller };
    setHistoryPage((current) => current.sid === sid && current.oldestEntryId === before
      ? { ...current, loading: true, failed: false }
      : current);

    let timedOut = false;
    let pageFailed = false;
    const deadline = withPageDeadline(controller.signal, EARLIER_PAGE_TIMEOUT_MS, () => { timedOut = true; });
    try {
      const result = await fetchSessionContext(
        sid,
        deadline.signal,
        { before, tail: SESSION_CONTEXT_PAGE_SIZE, skipCache: true },
      );
      const currentRequest = backfillRequestRef.current;
      if (
        currentRequest.sid !== sid
        || currentRequest.generation !== generation
        || sessionIdRef.current !== sid
      ) return false;
      // 会话文件在页面打开期间被删掉/归档：再自动重发只会一直 404，也翻不出任何东西。
      // 把分页关掉并说清楚，比在顶部显示一个永远重试失败的按钮好。
      if (result.kind === "missing") {
        setHistoryPage((current) => terminatePagination(current, sid));
        addNotice({ type: "error", message: translateRef.current("chat.sessionFileMissing") });
        return false;
      }
      if (result.kind !== "loaded") {
        pageFailed = true;
        return false;
      }

      const existingIds = new Set(entryIdsRef.current);
      if (result.snapshot.entryIds.some((id) => existingIds.has(id))) {
        throw new Error("历史分页返回了重复 entryId，已拒绝前插");
      }
      setMessages((current) => {
        const next = [...result.snapshot.messages, ...current];
        messagesRef.current = next;
        return next;
      });
      setEntryIds((current) => {
        const next = [...result.snapshot.entryIds, ...current];
        entryIdsRef.current = next;
        return next;
      });
      setHistoryPage({
        sid,
        oldestEntryId: result.snapshot.oldestEntryId,
        hasMore: result.snapshot.hasMore,
        turnsBefore: result.snapshot.turnsBefore,
        loading: false,
        failed: false,
      });
      return true;
    } catch (error) {
      const abortedElsewhere = !timedOut && error instanceof DOMException && error.name === "AbortError";
      if (!abortedElsewhere) {
        if (!timedOut) console.error("Failed to load earlier session messages:", error);
        // 同一个游标再自动重发一次，栅栏就没了：标记失败，等用户点重试。
        pageFailed = true;
      }
      return false;
    } finally {
      deadline.release();
      if (backfillRequestRef.current.generation === generation) {
        backfillRequestRef.current.controller = null;
        setHistoryPage((current) => current.sid === sid && current.loading
          ? { ...current, loading: false, failed: pageFailed }
          : current);
      }
    }
  }, [addNotice, historyPage]);

  /** 顶部「重试」：清掉失败标记后重发同一个游标（自动翻页此时是停着的）。 */
  const retryEarlierMessages = useCallback((): void => {
    setHistoryPage((current) => (current.failed ? { ...current, failed: false } : current));
    void loadEarlierMessages();
  }, [loadEarlierMessages]);

  /**
   * 按需连续向前翻页，直到包含指定 entryId 或到达分支起点；
   * 供大纲双击/点击「跳到对话」按需加载未加载的历史轮次，且一次提交减少中间重排。
   *
   * 页面按 JUMP_PAGE_SIZE 取，而不是首屏的 50：跳到大纲第一轮要跨过整段历史，
   * 固定的小页会把长会话切成上百次往返。页数上限只是防止服务端 hasMore 永不为假，
   * 正常分支在到达起点时自然结束；找不到目标时由调用方给出提示，不静默停在原地。
   */
  const loadUntilEntryId = useCallback(async (targetEntryId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    if (entryIdsRef.current.includes(targetEntryId)) return true;

    const initialPage = viewSnapshotRef.current.page;
    if (initialPage.sid !== sid || !initialPage.hasMore || !initialPage.oldestEntryId) return false;

    const generation = backfillRequestRef.current.generation + 1;
    backfillRequestRef.current.controller?.abort();
    const controller = new AbortController();
    backfillRequestRef.current = { sid, generation, controller };
    setHistoryPage((current) => current.sid === sid ? { ...current, loading: true } : current);

    let failedWhileJumping = false;
    // 只有「顶部游标那一页」失败才给顶部挂重试：后续页失败时顶部游标没变，
    // 从那里重试回不到这次跳转，重试入口留在大纲（再点一次那一轮）。
    let firstPageFailed = false;
    try {
      let before: string | null = initialPage.oldestEntryId;
      let hasMore: boolean = initialPage.hasMore;
      let turnsBefore = initialPage.turnsBefore;
      const prependedMessages: AgentMessage[] = [];
      const prependedEntryIds: string[] = [];
      const seenIds = new Set(entryIdsRef.current);
      let found = false;

      // 逐页请求同样带期限：任一页不返回时，顶部和大纲跳转按钮都不能一直转圈。
      const markJumpFailure = (isFirstPage: boolean) => {
        failedWhileJumping = true;
        if (isFirstPage) firstPageFailed = true;
      };
      const fetchJumpPage = async (cursor: string, isFirstPage: boolean) => {
        const deadline = withPageDeadline(controller.signal, EARLIER_PAGE_TIMEOUT_MS, () => markJumpFailure(isFirstPage));
        try {
          return await fetchSessionContext(sid, deadline.signal, { before: cursor, tail: JUMP_PAGE_SIZE, skipCache: true });
        } catch (error) {
          if (!failedWhileJumping && !(error instanceof DOMException && error.name === "AbortError")) markJumpFailure(isFirstPage);
          throw error;
        } finally {
          deadline.release();
        }
      };

      for (let step = 0; step < MAX_JUMP_PAGES && hasMore && before; step += 1) {
        const result = await fetchJumpPage(before, step === 0);
        const currentRequest = backfillRequestRef.current;
        if (
          currentRequest.sid !== sid
          || currentRequest.generation !== generation
          || sessionIdRef.current !== sid
        ) return false;
        // 与普通翻页同一处理：文件已经不在了就别再让大纲重复发同一个请求。
        if (result.kind === "missing") {
          setHistoryPage((current) => terminatePagination(current, sid));
          addNotice({ type: "error", message: translateRef.current("chat.sessionFileMissing") });
          return false;
        }
        if (result.kind !== "loaded") return false;

        if (result.snapshot.entryIds.some((id) => seenIds.has(id))) {
          throw new Error("历史分页返回了重复 entryId，已拒绝前插");
        }
        for (const id of result.snapshot.entryIds) seenIds.add(id);
        prependedMessages.unshift(...result.snapshot.messages);
        prependedEntryIds.unshift(...result.snapshot.entryIds);
        before = result.snapshot.oldestEntryId;
        hasMore = result.snapshot.hasMore;
        turnsBefore = result.snapshot.turnsBefore;
        if (result.snapshot.entryIds.includes(targetEntryId)) {
          found = true;
          break;
        }
      }

      if (prependedEntryIds.length > 0) {
        setMessages((current) => {
          const next = [...prependedMessages, ...current];
          messagesRef.current = next;
          return next;
        });
        setEntryIds((current) => {
          const next = [...prependedEntryIds, ...current];
          entryIdsRef.current = next;
          return next;
        });
        setHistoryPage({
          sid,
          oldestEntryId: before,
          hasMore,
          turnsBefore,
          loading: false,
          failed: failedWhileJumping,
        });
      }
      return found || entryIdsRef.current.includes(targetEntryId);
    } catch (error) {
      if (!failedWhileJumping && !(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load session messages until target entry:", error);
      }
      return false;
    } finally {
      if (backfillRequestRef.current.generation === generation) {
        backfillRequestRef.current.controller = null;
        setHistoryPage((current) => current.sid === sid && current.loading
          ? { ...current, loading: false, failed: firstPageFailed }
          : current);
      }
    }
  }, [addNotice]);
  const loadSessionDetails = useCallback((sid: string): void => {
    detailsRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = detailsRequestRef.current.generation + 1;
    detailsRequestRef.current = { generation, controller };
    void fetchSessionDetails(sid, controller.signal)
      .then((sessionDetails) => {
        if (
          detailsRequestRef.current.generation === generation
          && sessionIdRef.current === sid
          && contextVersionRef.current === sessionDetails.version
        ) setDetailsState({ sid, value: sessionDetails });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load session details:", error);
      });
  }, []);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    // `reloadedAfterRewrite` 只在内部用：补页发现文件被重写时重读一次首屏，避免无限重读。
    options: { preserveScroll?: boolean; validateView?: boolean; focusCompaction?: boolean; reloadedAfterRewrite?: boolean } = {},
  ) => {
    const performancePrefix = `pi-session:${sid}`;
    if (showLoading) {
      performance.clearMarks(`${performancePrefix}:request`);
      performance.mark(`${performancePrefix}:request`);
      if (performance.getEntriesByName(`${performancePrefix}:click`, "mark").length > 0) {
        performance.clearMeasures("pi-session-click-to-request");
        performance.measure("pi-session-click-to-request", `${performancePrefix}:click`, `${performancePrefix}:request`);
      }
    }
    backfillRequestRef.current.controller?.abort();
    backfillRequestRef.current = { sid, generation: backfillRequestRef.current.generation + 1, controller: null };
    const earlyRuntimeController = includeState ? new AbortController() : null;
    // 队列代次：每次加载与每次取回都会推进它，旧的预读因此不会把已清空的队列写回来。
    queueStateGenerationRef.current += 1;
    // 预读也用统一读取坐标：加载自己推进了队列代次，坐标里记的就是这一代。
    const runtimeRead = beginRuntimeRead();
    const earlyRuntimePromise = earlyRuntimeController
      ? fetchRuntimeState(sid, earlyRuntimeController.signal).then((snapshot) => {
          if (sessionIdRef.current === sid) {
            // 这一份只应用一次：加载结束时再应用一遍，会把期间到达的 compaction_start 盖回去。
            applyRuntimeSnapshot(runtimeRead, snapshot.state);
          }
          return snapshot;
        }).catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            // 失败的请求给不出「现在」：成功快照与实时事件才是运行状态的来源，按「没有状态」
            // 重置会清掉它们刚设置的压缩、命令状态（正在压缩时输入栏的「停止压缩」会消失）。
            console.error("Failed to load early session runtime state:", error);
          }
          return null;
        })
      : null;
    if (showLoading) setLoading(true);
    try {
      const readSeq = ++sessionReadSeqRef.current;
      // 实际提交进界面的那一份：恢复的更大窗口可能是它，而不是服务端这一页。
      // 补页要从它继续往前翻，否则会把已经恢复的历史换掉。
      let committedSnapshot: SessionContextSnapshot | null = null;
      const contextResult = await contextLoaderRef.current.run(
        sid,
        // 重写重试必须跳过本地缓存并让服务端按版本复验：否则拿回来的还是旧首屏和旧游标，
        // 补页再撞一次视图变化就停在那一页上（首次打开走 validateView，刷新路径没有）。
        (signal) => fetchSessionContext(sid, signal, {
          skipCache: options.validateView || options.reloadedAfterRewrite === true,
        }),
        (loaded) => {
          if (loaded.kind !== "missing" && (lastReadContextRef.current?.seq ?? 0) < readSeq) {
            lastReadContextRef.current = { sid, seq: readSeq, messages: loaded.snapshot.messages, entryIds: loaded.snapshot.entryIds ?? [] };
          }
          if (sessionIdRef.current !== sid) return false;
          if (loaded.kind === "missing") {
            if (showLoading) {
              setContextModel(null);
              contextVersionRef.current = null;
              setContextVersion(null);
              setDetailsState(null);
              setActiveLeafId(null);
              setMessages([]);
              setEntryIds([]);
              setBranchTailEntryIds(undefined);
              branchTailEntryIdsRef.current = undefined;
              messagesRef.current = [];
              entryIdsRef.current = [];
              setHistoryPage({ sid, oldestEntryId: null, hasMore: false, turnsBefore: 0, loading: false, failed: false });
              setError(null);
              setBlockedRecall(null);
              setExternalWriteBlocked(false);
              setRecalledPending(false);
              setRecallError(null);
              clearDraftRestorePending(sid);
            }
            setLoading(false);
            return false;
          }
          const saved = options.validateView ? getSessionViewSnapshot(sid) : null;
          if (saved && saved.revision === loaded.snapshot.version && saved.leafId === loaded.leafId
            && saved.entryIds.length >= loaded.snapshot.entryIds.length) {
            // 版本及活动 leaf 均一致才保留已分页的大窗口；其它元数据以服务端为准。
            const wider = { ...loaded.snapshot, messages: saved.messages, entryIds: saved.entryIds,
              oldestEntryId: saved.oldestEntryId, hasMore: saved.hasMore, turnsBefore: saved.turnsBefore };
            if (!commitContextSnapshot(sid, wider, loaded.leafId, { preserveScroll: true })) return null;
            committedSnapshot = wider;
            return loaded;
          }
          if (saved) deleteSessionViewSnapshot(sid);
          if (!commitContextSnapshot(sid, loaded.snapshot, loaded.leafId, options)) return null;
          committedSnapshot = loaded.snapshot;
          return loaded;
      });
      if (!contextResult.committed || !contextResult.value) return { loaded: false, agentState: null, runtimeRead: null };
      // 首屏一页可能全是过程记录（见 lib/session-page-budget.ts）：补几页再交给界面，
      // 否则打开会话看到的是空白。翻页只看服务端响应：游标、有没有消息都来自刚拿到的页，
      // 不读 ref 或 state —— 它们在同一个异步续体里可能还是上一帧、甚至上一个会话的值。
      const firstSnapshot = committedSnapshot ?? contextResult.value.snapshot;
      const firstLeafId = contextResult.value.leafId;
      // 补页期间会话文件被重写时，拿到的页属于另一个视图（版本或分支末端变了）。
      let viewChanged = false;
      // 已经合并出来的那一份：连补多页时在它上面继续往前接，而不是每次都从首屏重拼。
      let latestSnapshot = firstSnapshot;
      await backfillFirstPage({
        first: firstSnapshot,
        readOlder: async (before) => {
          const older = await contextLoaderRef.current.run(
            sid,
            (signal) => fetchSessionContext(sid, signal, { before, tail: SESSION_CONTEXT_PAGE_SIZE, skipCache: true }),
            (loaded) => loaded,
          ).catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              console.error("Failed to backfill the first session page:", error);
            }
            return { committed: false as const };
          });
          if (!older.committed || older.value.kind !== "loaded") return null;
          if (sessionIdRef.current !== sid) return null;
          // 两页接不上就别合并：先把首屏重读一遍，拿到新版本的那个视图。
          if (!sameSessionView(
            { version: firstSnapshot.version, leafId: firstLeafId },
            { version: older.value.snapshot.version, leafId: older.value.leafId },
          )) {
            viewChanged = true;
            return null;
          }
          return older.value;
        },
        commit: (page) => {
          if (sessionIdRef.current !== sid) return false;
          // 合并时只取旧页的消息、entryId 和游标；模型/思考强度/版本继承自首屏那页，
          // 否则会话尾部改过的设置会被「从 before 往上算」的旧值覆盖。
          // 在 latestSnapshot 上累加：以后补页条件放宽到「已有消息也继续翻」时不会丢中间页。
          const merged = mergeOlderPage(latestSnapshot, page.snapshot);
          if (!commitContextSnapshot(sid, merged, firstLeafId, options)) return false;
          latestSnapshot = merged;
          return true;
        },
      });
      if (viewChanged) {
        // 文件在补页期间被重写：这次的首屏与补页结果都过期了，重读一次（只重试一次，
        // 免得来回重读）；重读失败就保留当前这张带「加载更早消息」入口的页。
        if (!options.reloadedAfterRewrite) {
          // 磁盘上的文件已经变了，本地缓存的首屏一定过期，先丢掉再重读，重读走同一套补页流程。
          invalidateSessionContext(sid);
          return loadSession(sid, showLoading, includeState, { ...options, reloadedAfterRewrite: true });
        }
      }
      if (showLoading) {
        performance.clearMarks(`${performancePrefix}:data`);
        performance.mark(`${performancePrefix}:data`);
        performance.clearMeasures("pi-session-request-to-data");
        performance.measure("pi-session-request-to-data", `${performancePrefix}:request`, `${performancePrefix}:data`);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          performance.clearMarks(`${performancePrefix}:paint`);
          performance.mark(`${performancePrefix}:paint`);
          performance.clearMeasures("pi-session-data-to-paint");
          performance.measure("pi-session-data-to-paint", `${performancePrefix}:data`, `${performancePrefix}:paint`);
        }));
      }

      loadSessionDetails(sid);
      if (contextResult.value.cached) {
        void contextLoaderRef.current.run(
          sid,
          (signal) => fetchSessionContext(sid, signal, { skipCache: true }),
          (loaded) => {
            if (loaded.kind !== "loaded" || loaded.snapshot.version === contextVersionRef.current) return false;
            const committed = commitContextSnapshot(sid, loaded.snapshot, loaded.leafId, { preserveScroll: true });
            if (committed) loadSessionDetails(sid);
            return committed;
          },
        ).catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error("Failed to revalidate cached session context:", error);
          }
        });
      }

      if (!includeState) return { loaded: true, agentState: null, runtimeRead: null };
      runtimeStateRequestRef.current?.abort();
      const runtimeController = earlyRuntimeController ?? new AbortController();
      runtimeStateRequestRef.current = runtimeController;
      try {
        const agentState = earlyRuntimePromise ? await earlyRuntimePromise : await fetchRuntimeState(sid, runtimeController.signal);
        if (!agentState) return { loaded: true, agentState: null, runtimeRead };
        if (sessionIdRef.current !== sid || runtimeStateRequestRef.current !== runtimeController) {
          return { loaded: true, agentState: null, runtimeRead: null };
        }
        // 不再投影一遍：预读解析时已经应用过，加载期间到达的实时事件为最新。
        return { loaded: true, agentState, runtimeRead };
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // 同上：失败不重置运行状态。
          console.error("Failed to load session runtime state:", error);
        }
        return { loaded: true, agentState: null, runtimeRead };
      } finally {
        if (runtimeStateRequestRef.current === runtimeController) runtimeStateRequestRef.current = null;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { loaded: false, agentState: null, runtimeRead: null };
      }
      if (sessionIdRef.current === sid) {
        // 会话文件写入冲突已经重试过一次。屏幕上还有本会话内容时保留它并给提示，
        // 一次短暂的写入竞争不该把整个聊天区替换成错误页；没有内容可保留才回退错误页。
        if (
          isSessionExternalWriteError(error)
          && messagesRef.current.length > 0
          && viewSnapshotRef.current.page.sid === sid
        ) {
          addNotice({ type: "warning", message: "会话文件正在被写入，显示的是稍早的内容；写入结束后重新打开即可刷新" });
          setLoading(false);
          return { loaded: false, agentState: null, runtimeRead: null };
        }
        setError(String(error));
        setLoading(false);
        // 每次错误都按本次结果更新：一次外部写入失败之后重试遇到普通 500 时，
        // 旧的 true 会让错误页继续误报「另一个程序写入了这个会话文件」。
        setExternalWriteBlocked(isSessionExternalWriteError(error));
        // 普通错误（例如 500）也可能剩下只存在服务器内存里的消息：这次加载的预读已经取到队列，
        // 就按它决定入口。只靠预读写 `queuedMessages` 不够——错误页没有输入框，读的是 `blockedRecall`。
        // 上一次外部写入的探查可能已经被这次加载作废（代号与代次都推进了），不能指望它。
        if (!isSessionExternalWriteError(error) && sessionIdRef.current === sid) {
          // 用界面此刻显示的队列：每个写入入口都按读取序号与队列代次校验过，它比这次加载的
          // 预读更新（例如建连补读在预读之后拿到了另一标签页刚提交的消息）。
          const queued = queuedMessagesRef.current;
          setBlockedRecall(queued.steering.length > 0 || queued.followUp.length > 0 ? queued : null);
        }
        // 外部写入时 /context 一直 409，但 get_state / clear_queue 仍可用：队列里若还有只存在
        // 服务器内存中的消息，就让错误页给出取回入口，否则刷新后它们就再也拿不回来了。
        if (isSessionExternalWriteError(error)) {
          const requestId = blockedRecallRequestRef.current + 1;
          blockedRecallRequestRef.current = requestId;
          // 实时 queue_update 也会推进队列代次：它在取样之后到达时，这次探查已经过期。
          // 读取坐标同样要取：探查拿到的新队列如果只写 `blockedRecall`，之后返回的旧预读仍能
          // 通过「比已采纳的快照更新」的校验，把刚显示的入口再清掉。
          const probeRead = beginRuntimeRead();
          void fetchRuntimeState(sid, new AbortController().signal)
            .then((snapshot) => {
              // 这次查询期间队列可能已经被取回清空：它已经不是队列的真实状态了。
              if (requestId !== blockedRecallRequestRef.current) return;
              if (queueStateGenerationRef.current !== probeRead.queueGeneration) return;
              if (probeRead.seq <= lastAppliedQueueSeqRef.current) return;
              if (sessionIdRef.current !== sid) return;
              // 通过校验就是最新的队列状态：空了就清掉入口（另一个标签页可能已经取回了），
              // 否则页面会继续显示旧数量和已经失效的「移回」。写入口本身也同步 `blockedRecall`。
              // 只推进队列这枚序号：这次探查没取压缩等字段，不能把它们也判成过期。
              lastAppliedQueueSeqRef.current = probeRead.seq;
              updateQueuedMessages(normalizeQueuedMessages(snapshot?.state?.queuedMessages));
            })
            .catch(() => undefined);
        }
      }
      return { loaded: false, agentState: null, runtimeRead: null };
    }
  }, [addNotice, applyRuntimeSnapshot, beginRuntimeRead, commitContextSnapshot, loadSessionDetails, updateQueuedMessages]);

  /** Shadow lifecycle entry 使用单次 context-only 刷新，避免触发 details/backfill 或改变滚动位置。 */
  const scheduleContextRefresh = useCallback((sid: string) => {
    contextRefreshSchedulerRef.current.schedule(sid, async () => {
      if (sessionIdRef.current !== sid) return;
      invalidateSessionContext(sid);
      try {
        await contextLoaderRef.current.run(
          sid,
          (signal) => fetchSessionContext(sid, signal, { skipCache: true }),
          (loaded) => loaded.kind === "loaded"
            ? commitContextSnapshot(sid, loaded.snapshot, loaded.leafId, { preserveScroll: true })
            : false,
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to refresh Shadow lifecycle context:", error);
        }
      }
    });
  }, [commitContextSnapshot]);

  const loadCompactedSession = useCallback(async (sid: string, focusCompaction = false) => {
    // 压缩改变投影和活动 leaf；旧缓存、旧预取及已分页快照都不能复用。
    invalidateSessionContext(sid);
    deleteSessionViewSnapshot(sid);
    return loadSession(sid, false, false, { validateView: true, focusCompaction, preserveScroll: !focusCompaction });
  }, [loadSession]);

  const loadContext = useCallback(async (sid: string, leafId: string | null): Promise<boolean> => {
    try {
      const result = await contextLoaderRef.current.run(
        sid,
        (signal) => fetchSessionContext(sid, signal, { leafId }),
        (loaded) => {
          if (loaded.kind === "missing") return false;
          return commitContextSnapshot(sid, loaded.snapshot, loaded.leafId);
      });
      return result.committed && result.value;
    } catch (error) {
      if (sessionIdRef.current === sid) {
        console.error("Failed to load context:", error);
        setLoading(false);
      }
      return false;
    }
  }, [commitContextSnapshot]);

  // 每次读取一个序号：两条请求交错时（打开只读菜单会新发一次），较早发起的那条可能先拿到
  // `get_tools`、卡在 `get_tool_selection` 上，等新读取提交后才回来。只比较会话 id 挡不住它，
  // 会把旧清单写回界面，所以提交前还要求自己仍是这个会话最近一次读取。
  const toolListReadSeqRef = useRef(0);
  const loadTools = useCallback(async (sid: string) => {
    const readSeq = toolListReadSeqRef.current + 1;
    toolListReadSeqRef.current = readSeq;
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      // 钉死名单要单独问：`get_tools` 只知道此刻激活了哪些，分不清"用户没要"和"被扩展拿掉"。
      // 命令失败（旧服务端）时保持 null，界面上就不标注。
      const selection = await sendAgentCommand<{ pinned: string[] | null }>(sid, { type: "get_tool_selection" })
        .catch(() => null);
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        if (sessionIdRef.current === sid && toolListReadSeqRef.current === readSeq) {
          // 运行中的只读清单要照实展示这个会话能用哪些工具（扩展和 MCP 的也在内），
          // 内置工具子集只用来推预设档位和标注差异。
          // 名字保持服务端的：PowerShell 模式下激活的是 `powershell`，界面上不该冒充 `bash`；
          // 归一化后的内置工具子集只用来推预设档位和标注差异。
          const activeNames = [...new Set(tools.filter((tool) => tool.active).map((tool) => tool.name))];
          const names = activeNames.map(normalizeBuiltinToolName).filter((name) => SETTINGS_BUILTIN_TOOLS.includes(name));
          setActiveToolNames(activeNames);
          setPinnedToolNames(selection ? selection.pinned : null);
          setToolSelectionKnown(true);
          // 显示哪一档以会话记录的名单为准：扩展拿掉一个内置工具（如 hashline 替换 edit）
          // 不该把 configured/full 变成"自定义"。拿不到名单时才退回按实际激活的工具反推。
          if (selection) {
            const pinned = selection.pinned;
            if (pinned === null) {
              // 没有钉死名单 = 跟随 settings.json。
              setToolPresetState("configured");
              setCustomToolNames(null);
            } else {
              const preset = getPresetFromToolNames(pinned);
              const matches = getToolNamesForPreset(preset);
              setToolPresetState(preset);
              setCustomToolNames(matches && (matches.length !== pinned.length || !pinned.every((name) => matches.includes(name)))
                ? [...pinned]
                : null);
            }
          } else {
            // 旧服务端没有这条命令：只能按实际激活的工具反推。
            const preset = getPresetFromTools(tools);
            const matches = getToolNamesForPreset(preset);
            setToolPresetState(preset);
            setCustomToolNames(names.length > 0 && (matches?.length !== names.length || !names.every((name) => matches.includes(name))) ? names : null);
          }
        }
        return tools;
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
    return [];
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)", fromStash = false, capturedTransfer?: DraftTransfer | null) => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const active = isNavigationActive(navigationKey);
    if (fromStash && active) opts.chatInputRef?.current?.prepareDraftKeyChange(`new:${newSessionCwd}`);
    // 暂存库发送的是另一条消息，原输入需随新会话一起迁移。
    if (fromStash) {
      const transfer = capturedTransfer === undefined ? captureDraftTransfer(`new:${newSessionCwd}`) : capturedTransfer;
      transfer?.(sid);
    }
    const createdSession = {
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    };
    // 共享输入框 ref 在切换 worktree 后指向新草稿：旧首发的迟到确认只能后台收尾。
    if (!active) {
      onSessionCreatedInBackground?.(createdSession);
      return;
    }
    if (!fromStash) opts.chatInputRef?.current?.clearAcceptedPrompt();
    onSessionCreated?.(createdSession, { preserveDraft: fromStash });
  }, [isNew, isNavigationActive, navigationKey, newSessionCwd, onSessionCreated, onSessionCreatedInBackground, opts.chatInputRef]);

  const closeEvents = useCallback(() => {
    // 主动关闭也必须结算建连等待，否则卸载后的首发会一直等到连接超时。
    eventStreamConnectionRef.current?.cancel?.();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventStreamConnectionRef.current = null;
  }, []);

  // 建连实现依赖 applyRuntimeState 等一串回调，直接写进 executeBash 的依赖会让它每次渲染
  // 都换代；这里用 ref 取最新实现，executeBash 才能稳定地挂在 executeBashRef 上。
  const ensureConnectedRef = useRef<(sid: string) => Promise<void>>(async () => {});
  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    if (eventStreamRetryNoticeRef.current?.sessionId !== sid) eventStreamRetryNoticeRef.current = null;
    const startupFailure = eventStreamStartupFailureRef.current;
    if (startupFailure?.sessionId === sid) return Promise.resolve(startupFailure.result);
    eventStreamStartupFailureRef.current = null;
    // 并行的初始化请求复用同一条 SSE，避免互相关闭等待审批的连接。
    const existing = eventStreamConnectionRef.current;
    if (existing?.sessionId === sid && existing.source === eventSourceRef.current
      && existing.source.readyState !== STREAM_CLOSED
      && (existing.recovering || existing.source.readyState === STREAM_OPEN || !existing.settled)) return existing.promise;
    closeEvents();
    // 长连接经由同源 SharedWorker broker：连接数与窗口数解耦（不可用时自动直连）。
    const es = createStreamSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    // 共享上游只对第一个订阅者重放待处理问卷/审批；后接入的窗口自己补一次，
    // 否则第二个窗口看不到正在等的问卷，也无法接手回答。
    es.onNeedsReplay = () => {
      void sendAgentCommand(sid, { type: "replay_pending_ui" }).catch((error: unknown) => {
        console.error("请求重放待处理扩展 UI 失败:", error);
      });
    };
    eventSourceRef.current = es;
    let cancel: (() => void) | undefined;
    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      let terminalStartupFailure = false;
      const settle = (status: EventStreamConnectionStatus, errorMessage?: string, retryable?: boolean) => {
        if (settled) return;
        settled = true;
        if (eventStreamConnectionRef.current?.source === es) eventStreamConnectionRef.current.settled = true;
        clearTimeout(timeout);
        resolve({ status, source: es, errorMessage, retryable });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);
      cancel = () => settle("closed");
      es.onmessage = (e) => {
        if (eventSourceRef.current !== es || sessionIdRef.current !== sid) return;
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "startup_error") {
            const retryable = event.retryable !== false;
            terminalStartupFailure = !retryable;
            const detail = typeof event.errorMessage === "string" && event.errorMessage.trim()
              ? event.errorMessage : "Failed to start the agent event stream. Please try again.";
            const result: EventStreamConnectionResult = { status: "startup_error", source: es, errorMessage: detail, retryable };
            const connection = eventStreamConnectionRef.current;
            if (connection?.source === es) {
              connection.recovering = retryable;
              if (settled) connection.promise = Promise.resolve(result);
            }
            if (!retryable) eventStreamStartupFailureRef.current = { sessionId: sid, result };
            settle("startup_error", detail, retryable);
            if (!retryable) es.close();
            if (retryable) {
              const displayDetail = detail.trim();
              const previous = eventStreamRetryNoticeRef.current;
              if (!previous || previous.message !== displayDetail) {
                const notice = { sessionId: sid, id: previous?.id ?? createNoticeId(), message: displayDetail };
                eventStreamRetryNoticeRef.current = notice;
                addNotice({ id: notice.id, type: "error", message: displayDetail });
              }
            } else {
              addNotice({ id: `agent-event-startup:${sid}`, type: "error", expanded: true,
                message: `${detail}\n${translateRef.current("chat.eventStreamReplayBudgetHint")}` });
            }
            return;
          }
          if (event.type === "connected") {
            eventStreamRetryNoticeRef.current = null;
            terminalStartupFailure = false;
            const connection = eventStreamConnectionRef.current;
            if (connection?.source === es) {
              connection.recovering = false;
              // 第一次等待已向调用方报告失败，恢复后更新缓存结果，后续发送不再拿到旧失败。
              if (settled) connection.promise = Promise.resolve({ status: "connected", source: es });
            }
            settle("connected");
            // /state 可能早于冷启动完成返回；建连后重新读取扩展状态。
            // 与预读共用同一个入口：坐标在发请求前取，回来后按同一序号规则投影，
            // 这样「补读说空闲」也会被记为最新结论，加载结束时不会按旧预读再开一次回合。
            const controller = new AbortController();
            const connectRead = beginRuntimeRead();
            void fetchRuntimeState(sid, controller.signal).then((snapshot) => {
              if (eventSourceRef.current === es && sessionIdRef.current === sid) {
                applyRuntimeSnapshot(connectRead, snapshot.state);
              }
            }).catch((error: unknown) => {
              if (!(error instanceof DOMException && error.name === "AbortError")) {
                console.error("Failed to refresh runtime state after event stream connected:", error);
              }
            });
          }
          handleAgentEventRef.current?.(event);
        } catch (error) {
          console.error("处理会话 SSE 事件失败", error);
        }
      };
      es.onerror = () => {
        if (terminalStartupFailure) return;
        if (es.readyState !== STREAM_CLOSED) return;
        settle("closed");
        if (eventSourceRef.current === es && agentRunningRef.current) {
          eventSourceRef.current = null;
          setTimeout(() => {
            if (agentRunningRef.current && sessionIdRef.current === sid) void connectEvents(sid);
          }, 1000);
        }
      };
    });
    eventStreamConnectionRef.current = { sessionId: sid, source: es, promise, settled: false, recovering: false, cancel };
    return promise;
  }, [addNotice, applyRuntimeSnapshot, beginRuntimeRead, closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const result = await connectEvents(sid);
    if (result.status === "connected") return;
    const keepSubscription = result.status === "startup_error" && result.retryable !== false;
    if (!keepSubscription) {
      if (eventSourceRef.current === result.source) eventSourceRef.current = null;
      result.source.close();
    }
    throw new EventStreamConnectionError(result.status, result.errorMessage, keepSubscription);
  }, [connectEvents]);
  ensureConnectedRef.current = ensureEventsConnected;

  // The model and reasoning level a fresh composer's session started with, unless the user
  // picked others since `selectedModel` / `selectedThinkingLevel` were read.

  const ensureNewSession = useCallback(async () => {
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (pendingControlKind === "initialization-failed") {
      throw new Error(pendingNewSessionControl.error);
    }
    if (pendingControlKind === "materialized") {
      sessionIdRef.current = pendingNewSessionControl.sessionId;
      return pendingNewSessionControl.sessionId;
    }

    // 先等草稿的模型切换落地，再发 START/RETRY：状态机进入 materializing 之后就不再接收档位事件，
    // 在途的推荐档会被丢掉，创建请求会拿到新模型 + 旧档位。别的实例（切走再回来重建的那个）
    // 登记的同 cwd 切换也要等，否则它会绕过还没落地的选择拿旧模型创建。
    await awaitDraftModelSwitch();
    // 等待期间草稿还能改（模型、档位、Shadow 开关、工具档位），而且可能是在另一个实例里改的：
    // 创建参数按等完之后的最新草稿取，用等待之前捕获的那一份会让运行时按旧设置初始化。
    const latest = currentNewSessionSettings();
    const latestControl = latest.control;
    const latestView = latest.view;
    // 等的时候另一个入口可能已经把 runtime 建好了：直接接管，不再重复创建。
    if (latestControl.kind === "materialized" && latestView.transportSessionId) {
      sessionIdRef.current = latestView.transportSessionId;
      return latestView.transportSessionId;
    }
    // 身份一律取状态机的投影：漏掉任一等待态都会重复创建 runtime。
    const sessionRequest = selectNewSessionRequest(latestView);
    const requestedShadowMindEnabled = latestView.desiredShadowMindEnabled;
    if (latestControl.kind === "materialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, { type: "RETRY" });
    } else if (latestControl.kind === "staged") {
      onPendingNewSessionEvent(newSessionCwd, { type: "START" });
    }

    const selectedModel = latest.model;
    const selectedThinkingLevel = latest.thinkingLevel;
    if (selectedModel) setPendingModel(selectedModel);

    let result: NewSessionMaterializationResult;
    let streamConnectionError: EventStreamConnectionError | undefined;
    try {
      result = await materializeNewSession({
        ...sessionRequest,
        cwd: newSessionCwd,
        toolNames: currentNewSessionToolNames(),
        shadowMindEnabled: requestedShadowMindEnabled,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
        thinkingLevelExplicit: latest.thinkingLevelExplicit,
        thinkingLevelModel: latest.thinkingLevelModel,
        ...(fastEnabled && displayModelFastAvailable ? { fastEnabled: true } : {}),
      }, async (realId) => {
        onPendingNewSessionEvent(newSessionCwd, { type: "RUNTIME_CREATED", sessionId: realId });
        if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，初始化保留待恢复");
        sessionIdRef.current = realId;
        try {
          await ensureEventsConnected(realId);
        } catch (error) {
          // 初始化适配器会把异常压成错误文本，保留原类型供发送收尾判断是否仍需订阅。
          if (error instanceof EventStreamConnectionError) streamConnectionError = error;
          throw error;
        }
        if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，初始化保留待恢复");
      });
    } catch (error) {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "REQUEST_FAIL",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const realId = result.sessionId;
    // 旧挂载不能覆盖已由新挂载接管的初始化状态。
    if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，初始化保留待恢复");
    sessionIdRef.current = realId;
    if (result.kind === "materialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "POST_START_FAIL",
        sessionId: realId,
        error: result.error,
      });
      throw streamConnectionError ?? new Error(result.error);
    }

    applyShadowRuntimeState(result);
    if (result.kind === "initialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "INIT_FAIL",
        sessionId: realId,
        error: result.error,
      });
    } else {
      // finalize 与运行时快照走同一个协议投影：绑定失败（false + 错误文本）不能当作 ready。
      const binding = projectExtensionBinding(result);
      if (binding === "failed") {
        onPendingNewSessionEvent(newSessionCwd, {
          type: "POST_START_FAIL",
          sessionId: realId,
          error: result.extensionsError ?? "扩展初始化失败",
        });
      } else if (binding === "binding") {
        // runtime 已就绪但扩展仍在绑定：进入等待态，由 extensions_bound 事件解锁发送。
        onPendingNewSessionEvent(newSessionCwd, { type: "EXTENSIONS_PENDING", sessionId: realId });
      } else {
        onPendingNewSessionEvent(newSessionCwd, { type: "READY", sessionId: realId });
      }
    }
    if (result.model && newSessionModelOverrideRef.current === selectedModel) {
      setPendingModel(result.model);
      if (!newSessionModelOverrideRef.current) modelSelectionActions.setNewSessionDefaultModel(result.model);
    }
    if (
      isThinkingLevel(result.thinkingLevel)
      && (thinkingLevelOverrideRef.current ?? recommendedThinkingLevelRef.current) === selectedThinkingLevel
    ) {
      modelSelectionActions.setThinkingLevel(result.thinkingLevel);
    }
    await loadTools(realId);

    if (result.kind === "initialization-failed") throw new Error(result.error);
    return realId;
  }, [applyShadowRuntimeState, awaitDraftModelSwitch, currentNewSessionSettings, currentNewSessionToolNames, displayModelFastAvailable, ensureEventsConnected, fastEnabled, isNavigationActive, isNew, loadTools, modelSelectionActions, navigationKey, newSessionCwd, onPendingNewSessionEvent, pendingControlKind, pendingNewSessionControl]);

  // 系统面板可在首条消息发送前读取提示词；这里只初始化运行时并查询状态，
  // 不触发 prompt，也不会向会话历史追加消息。
  const loadSystemPrompt = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;
    // 只有这里需要整份提示词：其它 get_state 读取（思考强度、压缩开关、创建快照）不带它。
    const state = await sendAgentCommand<AgentRuntimeState>(sid, { type: "get_state", includeSystemPrompt: true });
    if (sessionIdRef.current !== sid) return;
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (set_tools may have rebuilt it as Chat only): forget the
  // list and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // An extension's session_start may wait on a dialog, which only the event stream shows (#1678),
  // and get_commands waits for session_start. A fresh composer has no stream (a prompt and a `!`
  // command open one themselves), so it holds one while the request is out, and lets go of it
  // after, as before, unless something in the page still needs it. A selected session keeps its own.
  const withSessionStartStream = useCallback(async <T,>(sid: string, request: () => Promise<T>): Promise<T> => {
    // get_commands 等待 session_start，审批窗口需要已有的会话事件流。
    void connectEvents(sid).catch((error) => console.error("[pi-web] 会话事件流连接失败", error));
    return request();
  }, [connectEvents]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const current = () => slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const data = await withSessionStartStream(sid, () => sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" }));
        const commands = data?.commands ?? [];
        if (current() && sessionIdRef.current === sid) replaceSlashCommands(commands);
        return commands;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands, withSessionStartStream]);

  const loadSlashCommands = useCallback(async () => {
    const commands = await requestSlashCommands();
    if (commands === null) throw new Error("读取扩展命令失败，请重试");
    return commands;
  }, [requestSlashCommands]);

  // The list a bare /mcp is decided by: the request under way (the palette starts
  // one as "/mcp" is typed, often still unanswered at Enter), else the list already
  // loaded, else a new request. Null when it cannot be read: guessing would either
  // swallow another extension's /mcp or send one Settings should have taken.
  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const loaded = await (pending ?? requestSlashCommands()).catch(() => null);
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);


  const sendExtensionUiResponse = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await sendAgentCommand(sid, {
      type: "extension_ui_response",
      id: request.id,
      ...response,
    });
  }, []);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (extensionDialogRef.current?.id === request.id) extensionDialogRef.current = null;
    if (!sid) return;
    try {
      await sendExtensionUiResponse(request, response);
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
      return;
    }
    // dialog 已关闭：重新检查服务器状态 —— 扩展可能已恢复运行（保持流式），
    // 也可能确实结束（此时补一次结束判定，避免 UI 一直停在运行态）
    if (agentRunningRef.current) {
      void reconcileAgentStateRef.current?.(sid, promptRunIdRef.current);
    }
  }, [sendExtensionUiResponse]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const setNoticeExpanded = useCallback((id: string, expanded: boolean) => {
    dispatchNotice({ type: "set_expanded", id, expanded, now: Date.now() });
  }, []);

  // Type something. 行内输入接力：见模块级 CUSTOM_ANSWER_ARM_MS 注释
  const pendingCustomAnswerRef = useRef<{ prefix: string; text: string; expiresAt: number } | null>(null);
  const armCustomAnswer = useCallback((prefix: string, text: string) => {
    pendingCustomAnswerRef.current = { prefix, text, expiresAt: Date.now() + CUSTOM_ANSWER_ARM_MS };
  }, []);

  // 第三方 ask 插件在 RPC 模式下逐题发请求；先缓存请求，待用户完成复核后再按原顺序回送。
  const queueAskQuestionnaireRequest = useCallback((request: ExtensionUiDialogRequest) => {
    if (askQuestionnaireRequestIdsRef.current.has(request.id)) return;
    askQuestionnaireRequestIdsRef.current.add(request.id);
    const waiter = askQuestionnaireRequestWaiterRef.current;
    if (waiter) {
      askQuestionnaireRequestWaiterRef.current = null;
      waiter.accept(request);
    } else {
      askQuestionnaireRequestQueueRef.current.push(request);
    }
  }, []);

  const takeAskQuestionnaireRequest = useCallback((): Promise<ExtensionUiDialogRequest> => {
    const queued = askQuestionnaireRequestQueueRef.current.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        askQuestionnaireRequestWaiterRef.current = null;
        reject(new Error("等待下一题请求超时"));
      }, 15_000);
      const accept = (request: ExtensionUiDialogRequest) => {
        clearTimeout(timeout);
        resolve(request);
      };
      askQuestionnaireRequestWaiterRef.current = {
        accept,
        cancel: () => {
          clearTimeout(timeout);
          reject(new Error("ask 问卷已取消"));
        },
      };
    });
  }, []);
  // 把未送达的文字（含附件）还回输入框；输入框已卸载时写回草稿，合并在已有内容之前。
  const restoreSubmission = useCallback((message: string, images: AttachedImage[] | undefined, draftKey: string | undefined) => {
    const draft = { value: message, images: (images ?? []).map(({ data, mimeType }) => ({ data, mimeType })) };
    const input = opts.chatInputRef?.current;
    if (input && sessionHookMountedRef.current && sessionIdRef.current === draftKey) {
      input.prependDraft(draft);
      return;
    }
    if (draftKey) setDraft(draftKey, prependChatDraft(draft, getDraft(draftKey) ?? { value: "", images: [] }));
  }, [opts.chatInputRef]);
  const translateRef = useRef(opts.t);
  translateRef.current = opts.t;
  const translate = useCallback((key: string, params?: TranslationParams) => translateRef.current(key, params), []);
  // /session 的摘要读运行时统计：它每次刷新都是新对象，读 ref 免得整个命令分发器跟着换代。
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  // A steer or follow-up whose request failed without the server's refusal (the
  // network dropped, a proxy answered) may still have been accepted. Its text
  // goes back to the composer all the same (restoreSubmission merges it in front
  // of anything typed since) and is never sent again on its own; this notice
  // says the send is unconfirmed rather than failed.
  const addUnconfirmedSendNotice = useCallback(() => {
    addNotice({ type: "warning", message: translate("chat.sendUnconfirmed") });
  }, [addNotice, translate]);

  // A normal send keeps its bubble while unconfirmed (#1432). Once the server is
  // idle, a session read started after that settles it: the prompt arrived only
  // if the read shows it, one more user message with its text past the view's
  // last saved entry at the send than the view already had there. Otherwise
  // the text goes back, as not received when the read ends on that entry, else
  // as unconfirmed: a read that moved on (messages the view had not saved, or
  // more than its window), failed, or a command, whose prompt need not become
  // that user message. Any of the run's events clears the record first
  // (markPromptLanded()).
  // The text is back in the composer and the prompt is not in the transcript:
  // its bubble goes, from the view and from the session's cached view. A read of
  // a file the prompt never changed keeps the view's messages (the snapshot
  // revision is the same), so it would never drop the bubble itself.
  const dropUnconfirmedBubble = useCallback((pending: UnconfirmedSend) => {
    if (sessionHookMountedRef.current) setMessages((prev) => withoutMessage(prev, pending.bubble));
    const snapshot = getSessionViewSnapshot(pending.sid);
    if (snapshot?.messages.includes(pending.bubble)) {
      setSessionViewSnapshot({ ...snapshot, messages: withoutMessage(snapshot.messages, pending.bubble) });
    }
  }, []);
  const settleUnconfirmedSend = useCallback((sid: string, runId: number, readSeqBefore: number) => {
    const pending = unconfirmedSendRef.current;
    if (!pending || pending.runId !== runId || pending.sid !== sid) return;
    unconfirmedSendRef.current = null;
    const read = lastReadContextRef.current;
    const reread = read?.sid === sid && read.seq > readSeqBefore ? read : null;
    // Where the read goes past the send's last entry; -1 when that entry fell out of its window.
    const start = !reread ? -1
      : pending.lastEntryIdAtSend === null ? 0
        : reread.entryIds.indexOf(pending.lastEntryIdAtSend) + 1 || -1;
    if (reread && start >= 0) {
      const sameText = countUserMessages(reread.messages.slice(start), pending.key);
      if (sameText > pending.sameTextAfterSend) return;
    }
    restoreSubmission(pending.message, pending.images, pending.draftKey);
    setSubmissionError({ navigationKey, message: translate(reread && !pending.command && start === reread.entryIds.length
      ? "chat.sendNotReceived" : "chat.sendUnconfirmed") });
    // A failed read leaves the view stale: the bubble stays with "could not confirm".
    if (reread) dropUnconfirmedBubble(pending);
    addNotice(reread && !pending.command && start === reread.entryIds.length
      ? { type: "error", message: translate("chat.sendNotReceived") }
      : { type: "warning", message: translate("chat.sendUnconfirmed") });
  }, [addNotice, dropUnconfirmedBubble, navigationKey, restoreSubmission, translate]);
  // The hook unmounts (a session switch) with a send still unconfirmed: nothing
  // here will settle it, so its text goes back unless one of the run's events
  // cleared the record. With the stream closed, a prompt that did arrive is
  // given back too, without a notice. A fresh composer's goes to its cwd's
  // parked draft: its session has no row and no draft of its own until a
  // prompt reaches it (getRpcSessionInfos()). The cached view loses the bubble:
  // coming back, a read of an unchanged file keeps that view, and a changed
  // one replaces it with the prompt if it did arrive.
  const releaseUnconfirmedSend = useCallback(() => {
    const pending = unconfirmedSendRef.current;
    unconfirmedSendRef.current = null;
    if (!pending) return;
    if (pending.parkedDraftKey) {
      restoreSubmission(pending.message, pending.images, pending.parkedDraftKey);
    } else {
      restoreSubmission(pending.message, pending.images, pending.draftKey);
    }
    dropUnconfirmedBubble(pending);
  }, [dropUnconfirmedBubble, restoreSubmission]);
  const releaseUnconfirmedSendRef = useRef(releaseUnconfirmedSend);
  releaseUnconfirmedSendRef.current = releaseUnconfirmedSend;

  const clearAskQuestionnaire = useCallback(() => {
    askQuestionnaireRequestQueueRef.current = [];
    askQuestionnaireRequestIdsRef.current.clear();
    askQuestionnaireRequestWaiterRef.current?.cancel();
    askQuestionnaireRequestWaiterRef.current = null;
    askQuestionnaireRef.current = null;
    setAskQuestionnaire(null);
  }, []);

  const cancelAskQuestionnaire = useCallback(() => {
    const currentRequest = askQuestionnaireRequestQueueRef.current.shift();
    clearAskQuestionnaire();
    if (currentRequest) {
      void sendExtensionUiResponse(currentRequest, { cancelled: true }).catch((error) => {
        console.error("取消 ask 问卷失败:", error);
      });
    }
  }, [clearAskQuestionnaire, sendExtensionUiResponse]);

  const submitAskQuestionnaire = useCallback(async (answers: AskQuestionnaireAnswer[]) => {
    const questionnaire = askQuestionnaireRef.current;
    if (!questionnaire || answers.length !== questionnaire.questions.length) return;
    const markSubmitting = { ...questionnaire, submitting: true, error: undefined };
    askQuestionnaireRef.current = markSubmitting;
    setAskQuestionnaire(markSubmitting);

    try {
      for (let index = 0; index < answers.length; index++) {
        const request = await takeAskQuestionnaireRequest();
        const question = questionnaire.questions[index];
        const answer = answers[index];

        if (answer.kind === "custom") {
          if (question.multiSelect) {
            if (request.method !== "input") throw new Error("多选题请求类型无效");
            await sendExtensionUiResponse(request, { value: answer.text });
          } else {
            if (request.method !== "select") throw new Error("自定义答案缺少选项请求");
            const sentinel = request.options[request.options.length - 1];
            await sendExtensionUiResponse(request, { value: sentinel });
            const inputRequest = await takeAskQuestionnaireRequest();
            if (inputRequest.method !== "input") throw new Error("自定义答案缺少输入请求");
            await sendExtensionUiResponse(inputRequest, { value: answer.text });
          }
          continue;
        }

        if (question.multiSelect) {
          if (request.method !== "input") throw new Error("多选题请求类型无效");
          await sendExtensionUiResponse(request, {
            value: answer.optionIndexes.map((value) => value + 1).join(","),
          });
        } else {
          if (request.method !== "select") throw new Error("单选题请求类型无效");
          const option = request.options[answer.optionIndexes[0]];
          if (!option) throw new Error("未选择有效答案");
          await sendExtensionUiResponse(request, { value: option });
        }
      }
      submittedAskToolCallIdsRef.current.add(questionnaire.toolCallId);
      clearAskQuestionnaire();
    } catch (error) {
      // 中止或工具已结束时不要让迟到的超时回调重新弹出已关闭问卷。
      if (askQuestionnaireRef.current?.toolCallId !== questionnaire.toolCallId) return;
      const failed = {
        ...questionnaire,
        submitting: false,
        error: error instanceof Error ? error.message : String(error),
      };
      askQuestionnaireRef.current = failed;
      setAskQuestionnaire(failed);
    }
  }, [clearAskQuestionnaire, sendExtensionUiResponse, takeAskQuestionnaireRequest]);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (
      askQuestionnaireRef.current
      && (request.method === "select" || request.method === "input")
    ) {
      queueAskQuestionnaireRequest(request);
      return;
    }
    switch (request.method) {
      case "select":
      case "confirm":
      case "editor":
        setExtensionDialog(request);
        extensionDialogRef.current = request;
        break;
      case "input": {
        // Type something. 行内输入接力：匹配（同问题前缀、未过期）则自动应答，不弹窗
        const pending = pendingCustomAnswerRef.current;
        if (pending) {
          pendingCustomAnswerRef.current = null; // 一次性消费
          if (Date.now() < pending.expiresAt && request.title.startsWith(pending.prefix)) {
            void respondToExtensionUi(request, { value: pending.text });
            break;
          }
        }
        setExtensionDialog(request);
        extensionDialogRef.current = request;
        break;
      }
      case "notify": {
        if (request.id && !isFirstNoticeShowing(request.id)) break;
        addNotice({
          id: request.id,
          message: stripAnsi(request.message),
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        extensionStatusesRevisionRef.current += 1;
        extensionStatusKeyRevisionsRef.current.set(request.statusKey, extensionStatusesRevisionRef.current);
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        extensionWidgetsRevisionRef.current += 1;
        extensionWidgetKeyRevisionsRef.current.set(request.widgetKey, extensionWidgetsRevisionRef.current);
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines && request.widgetLines.length > 0
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = stripAnsi(request.title);
        break;
      case "set_editor_text":
        // pi's editor setText(): the draft is replaced (an empty text clears it).
        opts.chatInputRef?.current?.setText(stripAnsi(request.text));
        break;
      case "custom":
        if (request.closed) {
          setExtensionCustomUi((current) => current?.id === request.id ? null : current);
        } else setExtensionCustomUi(request);
        break;
    }
  }, [addNotice, isFirstNoticeShowing, opts.chatInputRef, queueAskQuestionnaireRequest, respondToExtensionUi]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    if (session?.id === sid) {
      cancelEventStreamGrace();
      return;
    }
    cancelEventStreamGrace();
    const generation = eventStreamGraceGenerationRef.current;
    eventStreamGraceTimerRef.current = setTimeout(() => {
      if (
        generation === eventStreamGraceGenerationRef.current
        && sessionIdRef.current === sid
        && !agentRunningRef.current
        && pendingDetachedSubagentIdsRef.current.size === 0
        && !shadowLifecycleRef.current.hasActiveRuns
      ) closeEvents();
    }, EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, session?.id]);

  /** 本地发送、外部 agent_start 与挂载恢复统一从这里采用主运行。 */
  const enterMainRun = useCallback((phase: AgentPhase): number => {
    backfillRequestRef.current.controller?.abort();
    backfillRequestRef.current.generation += 1;
    if (!agentRunningRef.current) {
      const sid = sessionIdRef.current;
      if (sid) clearManualStopNotificationSuppression(sid);
      resetStreamDeltas();
      const runId = promptRunIdRef.current + 1;
      promptRunIdRef.current = runId;
      lastRunAbortedRef.current = false;
      beginRun(runId);
      agentRunningRef.current = true;
    }
    setAgentRunning(true);
    setAgentPhase(phase);
    dispatch({ type: "start" });
    return promptRunIdRef.current;
  }, [beginRun, dispatch, resetStreamDeltas]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // completion 控制器负责当前轮校验与重复 settled 拒绝。
    if (!settleRun(runId, sid, lastRunAbortedRef.current, lastRunSubagentsActiveRef.current)) return;

    // 服务端确认 idle 后立即发布完成事件；消息重载不能阻塞声音和系统通知。
    agentRunningRef.current = false;
    if (sid) scheduleEventStreamClose(sid);
    optimisticUserMessageKeyRef.current = null;
    setAgentRunning(false);
    setAgentPhase(null);
    // 命令也结束了：pi 不会为主运行发 prompt_done，界面上的「执行命令中：/…」同样要清掉。
    setRunningCommands([]);
    setRetryInfo(null);
    flushStreamDeltas();
    dispatch({ type: "end" });
    if (sid) {
      // AppShell coordinator 合并新会话的 settled 与标题刷新。
      onSessionListRefresh?.({ reason: "run-settled", sessionId: sid });
      // 先提交最终上下文，再发出结束定位，避免初始定位覆盖底部位置。
      invalidateSessionContext(sid);
      const readSeqBefore = sessionReadSeqRef.current;
      void loadSession(sid, false, false, { preserveScroll: true }).then(() => {
        // The server is idle: an unconfirmed send of this run either is in the
        // read just made or never arrived.
        settleUnconfirmedSend(sid, runId, readSeqBefore);
        const result = lastReadContextRef.current;
        if (sessionIdRef.current === sid && result?.sid === sid && result.seq > deferredBashReadSeqRef.current) {
          setPendingBash((pending) => pending?.result && result.messages.some((message) => (
            message.role === "bashExecution" && message.command === pending.command
            && (message.timestamp ?? 0) >= pending.startedAt
          )) ? null : pending);
        }
        if (sessionIdRef.current === sid) requestScrollPosition("running-end");
      });
    }
  }, [settleUnconfirmedSend, dispatch, flushStreamDeltas, loadSession, onSessionListRefresh, requestScrollPosition, scheduleEventStreamClose, settleRun, setRunningCommands]);

  const readAgentSnapshot = useCallback(async (sid: string): Promise<AgentRuntimeSnapshot | null> => {
    try {
      const response = await fetch(agentStatusUrl(sid), { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json() as AgentRuntimeSnapshot;
    } catch {
      return null;
    }
  }, []);

  const applyAgentSnapshot = useCallback(async (
    sid: string,
    runId: number,
    snapshot: AgentRuntimeSnapshot,
    usageRequestId: number,
    read: RuntimeRead,
  ) => {
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return;
    applyRuntimeSnapshot(read, snapshot.state, { sid, runId, requestId: usageRequestId });

    if (snapshot.busy) {
      agentRunningRef.current = true;
      setAgentRunning(true);
      return;
    }
    // 扩展 UI 等待用户输入时 wrapper 可能暂时 idle，不能提前结束交互。
    if (extensionDialogRef.current || askQuestionnaireRef.current || !agentRunningRef.current) return;
    await finishPromptWithoutStream(sid, runId);
  }, [applyRuntimeSnapshot, finishPromptWithoutStream]);

  const reconcileAgentState = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const generation = reconcileRequestGenerationRef.current + 1;
    reconcileRequestGenerationRef.current = generation;
    const usageRequestId = ++contextUsageRequestIdRef.current;
    // 坐标必须在发请求之前取：回来时若已有更新的队列或压缩事件，这份快照就不能覆盖它们。
    const read = beginRuntimeRead();
    const snapshot = await readAgentSnapshot(sid);
    // 同一 run 的多个触发可能乱序返回，只允许最新请求提交状态。
    if (generation !== reconcileRequestGenerationRef.current || !snapshot) return;
    await applyAgentSnapshot(sid, runId, snapshot, usageRequestId, read);
  }, [applyAgentSnapshot, beginRuntimeRead, readAgentSnapshot]);
  reconcileAgentStateRef.current = reconcileAgentState;

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(agentStatusUrl(sid));
        if (!res.ok) continue;
        const data = await res.json() as AgentRuntimeSnapshot;
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);


  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const idleReadAfterBashRef = useRef<string | null>(null);
  const readIdleMessages = useCallback(async (sid: string) => {
    const beforeRead = sessionReadSeqRef.current;
    const versions = contextVersionRef.current;
    const response = await fetchSessionContext(sid, new AbortController().signal, { tail: 1, skipCache: true });
    if (response.kind !== "loaded" || sessionIdRef.current !== sid || !sessionHookMountedRef.current
      || agentRunningRef.current || sessionReadSeqRef.current !== beforeRead || contextVersionRef.current !== versions) return;
    const anchor = entryIdsRef.current.at(-1);
    const page = viewSnapshotRef.current.page;
    const added = anchor && messagesRef.current.length === entryIdsRef.current.length
      ? entriesAfter(anchor, response.snapshot)
      : null;
    if (!anchor || !added || page.sid !== sid) {
      await loadSession(sid, false, false, { preserveScroll: true });
      return;
    }
    if (added.entryIds.length === 0) return;
    if (bashRunningRef.current && added.messages.some((message) => message.role === "bashExecution")) {
      idleReadAfterBashRef.current = sid;
      return;
    }
    commitContextSnapshot(sid, {
      ...response.snapshot,
      messages: [...messagesRef.current, ...added.messages],
      entryIds: [...entryIdsRef.current, ...added.entryIds],
      branchTailEntryIds: mergeBranchTailEntryIds(anchor, branchTailEntryIdsRef.current, response.snapshot.branchTailEntryIds),
      oldestEntryId: page.oldestEntryId,
      hasMore: page.hasMore,
      turnsBefore: page.turnsBefore,
    }, response.leafId, { preserveScroll: true });
    loadSessionDetails(sid);
  }, [commitContextSnapshot, loadSession, loadSessionDetails]);
  const readIdleMessagesRef = useRef(readIdleMessages);
  readIdleMessagesRef.current = readIdleMessages;
  const idleMessageReadsRef = useRef<((sid: string) => void) | null>(null);
  idleMessageReadsRef.current ??= createIdleMessageReads({
    pendingReads: (sid) => [contextLoaderRef.current.whenIdle(sid)],
    read: (sid) => readIdleMessagesRef.current(sid),
    wanted: (sid) => sessionHookMountedRef.current && sessionIdRef.current === sid && !agentRunningRef.current,
    onError: (error) => console.error("[pi-web] 无法读取扩展发送的消息", error),
  });

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    if (endedSessionRef.current) return;
    switch (event.type) {
      case "session_ended": {
        const sid = sessionIdRef.current;
        if (!sid || event.sessionId !== sid) return;
        // The owner leaves the session (a fresh composer, or the tab closes) and this view
        // unmounts; until then nothing reconnects, which would start the runtime again.
        endedSessionRef.current = sid;
        cancelEventStreamGrace();
        closeEvents();
        deleteSessionViewSnapshot(sid);
        onSessionEnded?.(sid);
        return;
      }
      case "connected": {
        // 重连只清理服务端已经关闭的弹窗；保留同一工具问卷的已填写状态。
        if (Array.isArray(event.pendingExtensionUiIds)) {
          const pending = new Set(event.pendingExtensionUiIds as string[]);
          setExtensionDialog((current) => current && pending.has(current.id) ? current : null);
          if (extensionDialogRef.current && !pending.has(extensionDialogRef.current.id)) extensionDialogRef.current = null;
          setExtensionCustomUi((current) => current && pending.has(current.id) ? current : null);
        }
        // The replay that follows brings each running call's start with its elapsed time.
        setToolClocks(endedToolClocks);
        if (event.isStreaming === true) {
          cancelEventStreamGrace();
          if (!agentRunningRef.current) enterMainRun({ kind: "waiting_model" });
        }
        // Opening the stream is what resumes an idle-reaped session, so the
        // mount's state read may have found no runtime and no usage to show.
        if (sessionIdRef.current) void refreshContextUsage(sessionIdRef.current);
        // 冷会话的首屏可能早于 runtime 恢复：连接就绪后补读，预设名称不必等整页刷新。
        if (!toolSelectionKnown && sessionIdRef.current) void loadTools(sessionIdRef.current);
        break;
      }
      case "agent_start":
        markPromptLanded();
        cancelEventStreamGrace();
        // 新一轮运行开始：重置流式消息计数（message_end 的 updater 会重新累计）。
        lastStreamedMessageCountRef.current = 0;
        lastRunAbortedRef.current = false;
        // 重试的等待在其运行开始时就结束了（与 pi TUI 一致）：成功的 auto_retry_end
        // 要等重试的第一条完整回复才到，期间可能流式输出好几分钟（#988）。
        setRetryInfo(null);
        enterMainRun({ kind: "waiting_model" });
        break;
      case "entry_appended": {
        const sid = sessionIdRef.current;
        if (!sid) break;
        const entry = event.entry as SessionEntry | undefined;
        consumeShadowEntry(entry);
        const lifecycle = shadowLifecycleRef.current.consume(entry);
        if (lifecycle.changed) {
          if (lifecycle.hasActiveRuns) cancelEventStreamGrace();
          scheduleContextRefresh(sid);
          if (!agentRunningRef.current && !lifecycle.hasActiveRuns) scheduleEventStreamClose(sid);
        }
        break;
      }
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done and server-idle settlement.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        flushStreamDeltas();
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          // 结束事件后始终从服务端重新读取最终上下文，不能仅依据本地 messageCount 跳过；
          // 该刷新仍处于运行边界，必须保留滚动，最终 settled 再统一定位到底部。
          invalidateSessionContext(sessionIdRef.current);
          void loadSession(sessionIdRef.current, false, false, { preserveScroll: true });
          void reconcileAgentState(sessionIdRef.current, promptRunIdRef.current);
        }
        break;
      case "agent_settled":
      case "prompt_done":
        if (event.type === "agent_settled") lastRunAbortedRef.current = event.aborted === true;
        else if (event.aborted === true) lastRunAbortedRef.current = true;
        // Subagents still at work report back with a run of their own: the task is not done yet (#1434).
        lastRunSubagentsActiveRef.current = event.subagentsActive === true;
        if (event.type === "prompt_done") markPromptLanded();
        if (!agentRunningRef.current || !sessionIdRef.current) break;
        void reconcileAgentState(sessionIdRef.current, promptRunIdRef.current);
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "session_title_generated":
        // 服务端第一轮结束后异步生成的标题已写回会话文件：刷新侧栏列表显示新标题。
        if (sessionIdRef.current) {
          onSessionListRefresh?.({ reason: "title-generated", sessionId: sessionIdRef.current });
        }
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: extensionErrorMessage(event.extensionPath, (event.error as string | undefined) ?? "Extension command failed"),
        });
        break;
      case "message_start":
        if (isSystemMessageEvent(event)) break;
        // Reconnects may receive the in-flight assistant snapshot before the
        // next delta. The reducer owns the canonical streaming message shape.
        if (!agentRunningRef.current) break;
        resetStreamDeltas();
        if (event.message) dispatch({ type: "snapshot", message: event.message as AgentMessage });
        setAgentPhase(null);
        break;
      case "message_update": {
        if (isSystemMessageEvent(event)) break;
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as AgentMessage | undefined;
        if (msg?.role === "user") break;
        const needsPhaseReset = streamingStore.getState().streamingMessage === null;
        const assistantMessageEvent = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
        if (assistantMessageEvent) {
          enqueueStreamDelta(assistantMessageEvent);
        } else if (msg) {
          // Compatibility with older servers that sent a cumulative partial.
          resetStreamDeltas();
          dispatch({ type: "snapshot", message: normalizeAssistantMessage(msg) });
        }
        // message_start 已清掉阶段；只有兼容缺少 start 的首个快照才需要补清，
        // 避免每个 chunk 都派发同一个 null（React 仍可能额外执行一次父组件）。
        if (needsPhaseReset) setAgentPhase(null);
        break;
      }
      case "message_end": {
        if (isSystemMessageEvent(event)) break;
        const completed = event.message as AgentMessage | undefined;
        // detached completion 可能在父轮结束后到达，状态区仍必须消费。
        if (!agentRunningRef.current && completed?.role !== "custom") break;
        flushStreamDeltas();
        // 新会话首条用户消息落盘时发布一次；中间工具边界由轻量 running 轮询展示。
        if (isNew && completed?.role === "user") {
          const sid = sessionIdRef.current;
          if (sid) onSessionListRefresh?.({ reason: "new-session-persisted", sessionId: sid });
        }
        if (completed?.role === "toolResult" && completed.toolName === "subagent_spawn" && !completed.isError) {
          const text = contentText(completed.content);
          const detailAgent = completed.details as { agent?: { id?: unknown } } | undefined;
          const agentId = typeof detailAgent?.agent?.id === "string"
            ? detailAgent.agent.id
            : text.match(/\b(sa_[0-9a-f-]+)\b/i)?.[1];
          if (agentId) pendingDetachedSubagentIdsRef.current.add(agentId);
        }
        const completedSubagentIds = completed ? completedDetachedSubagentIds(completed) : [];
        const inspectedTerminalIds = completed?.role === "toolResult" && completed.toolName === "subagent_inspect"
          ? ((completed.details as { runs?: Array<{ id?: unknown; state?: unknown }> } | undefined)?.runs ?? [])
              .filter((run) => typeof run.id === "string" && (run.state === "completed" || run.state === "failed"))
              .map((run) => run.id as string)
          : [];
        const terminalSubagentIds = [...new Set([...completedSubagentIds, ...inspectedTerminalIds])];
        for (const agentId of terminalSubagentIds) pendingDetachedSubagentIdsRef.current.delete(agentId);
        if (!agentRunningRef.current && terminalSubagentIds.length > 0 && sessionIdRef.current) {
          scheduleEventStreamClose(sessionIdRef.current);
        }
        if (!agentRunningRef.current && completed?.role === "custom") {
          // 空闲扩展消息统一从持久化历史补齐，避免消息和 entryId 的位置错开。
          if (completed.display && sessionIdRef.current) idleMessageReadsRef.current?.(sessionIdRef.current);
          break;
        }
        if (completed && completed.role === "user") {
          // SDK 为了展开 inline skill 会把命令整理到前缀；展示层保留发送前的原始输入。
          // 仅替换仍紧邻末尾的乐观消息，队列消息在首轮 message_end 后会正常追加。
          const delivered = normalizeAssistantMessage(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          // While the run's own bubble waits, a delivered user message is its prompt.
          if (optimisticKey) markPromptLanded();
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : prev;
            }
            const next = [...prev, delivered];
            lastStreamedMessageCountRef.current = next.length;
            return next;
          });
        } else if (completed) {
          // pi's showCacheMissNotices (#1265): the wrapper sends them beside the message.
          const notices = Array.isArray(event.transcriptNotices) ? event.transcriptNotices as TranscriptNotice[] : undefined;
          setMessages((prev) => {
            const next = [...prev, withTranscriptNotices(normalizeAssistantMessage(completed), notices)];
            lastStreamedMessageCountRef.current = next.length;
            return next;
          });
          if (completed.role === "assistant" && sessionIdRef.current) void refreshContextUsage(sessionIdRef.current);
        }
        dispatch({ type: "end" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        // A call a tool made itself (a codemode script's) belongs to its
        // parent's card; listed here it would show as a top-level running tool,
        // and a call cut off by its script can end after the parent did.
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setToolClocks((previous) => applyToolClockEvent(previous, event, performance.now()));
        if (name === "ask_user_question") {
          const questions = parseAskQuestionnaire(event.args);
          // SSE 重连会重放同一工具开始事件；保留当前页、已选答案和请求去重状态。
          if (
            questions
            && !submittedAskToolCallIdsRef.current.has(id)
            && askQuestionnaireRef.current?.toolCallId !== id
          ) {
            const questionnaire = { toolCallId: id, questions, submitting: false };
            askQuestionnaireRequestQueueRef.current = [];
            askQuestionnaireRequestIdsRef.current.clear();
            askQuestionnaireRef.current = questionnaire;
            setAskQuestionnaire(questionnaire);
          }
        }
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const partialResult = event.partialResult as Partial<ToolResultMessage> | undefined;
        const content = partialResult?.content;
        // Live output for shells; for codemode, the calls its script has made so far.
        if ((name === "bash" || name === "powershell" || name === CODEMODE_TOOL_NAME) && Array.isArray(content)) {
          setActiveToolResults((prev) => {
            const next = new Map(prev);
            next.set(id, {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              timestamp: Date.now(),
              isError: partialResult?.isError,
              details: partialResult?.details,
            });
            return next;
          });
        }
        const progress = name === CODEMODE_TOOL_NAME
          ? getCodemodeProgress(event.partialResult)
          : getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        setToolClocks((previous) => applyToolClockEvent(previous, event, performance.now()));
        onToolEnd?.(event.toolName as string);
        setActiveToolResults((previous) => {
          if (!previous.has(id)) return previous;
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
        submittedAskToolCallIdsRef.current.delete(id);
        if (askQuestionnaireRef.current?.toolCallId === id) clearAskQuestionnaire();
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "queue_update": {
        // 实时队列是最新的：在途的补读、重查结果一律作废，别把旧队列盖回来。
        queueStateGenerationRef.current += 1;
        const queued = normalizeQueuedMessages(event as Partial<QueuedMessages>);
        // 唯一入口同时更新错误页的入口（加载失败时输入框没有挂载，页面读的就是它）。
        updateQueuedMessages(queued);
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_continue":
        addNotice({ type: "info", message: "检测到上轮工具调用未执行完成，已自动继续" });
        break;
      case "auto_continue_stopped":
        addNotice({ type: "warning", message: "自动继续已停止：工具调用反复无法完成，请检查环境或手动处理" });
        break;
      case "extensions_bound":
        // 新会话第二阶段不等绑定；绑定完成的事件是解锁发送的信号。
        if (newSessionCwd && sessionIdRef.current) {
          const model = event.model as Partial<SelectedModel> | undefined;
          if (isNew && !modelSwitchPendingRef.current && typeof model?.provider === "string" && typeof model.modelId === "string") {
            const selected = { provider: model.provider, modelId: model.modelId };
            setPendingModel(selected);
            if (!newSessionModelOverrideRef.current) modelSelectionActions.setNewSessionDefaultModel(selected);
            if (isThinkingLevel(event.thinkingLevel)) modelSelectionActions.setThinkingLevel(event.thinkingLevel);
          }
          onPendingNewSessionEvent(newSessionCwd, { type: "EXTENSIONS_READY", sessionId: sessionIdRef.current });
        }
        break;
      case "extensions_error":
        if (newSessionCwd && sessionIdRef.current) {
          onPendingNewSessionEvent(newSessionCwd, {
            type: "POST_START_FAIL",
            sessionId: sessionIdRef.current,
            error: typeof event.errorMessage === "string" ? event.errorMessage : "扩展初始化失败",
          });
        }
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      // A compaction's or branch summary's summarizer call failed and waits to try
      // again, on the same retry budget as a turn: pi's TUI shows the error and the
      // countdown, here the retry banner does for the wait, as for a turn's retry.
      case "summarization_retry_scheduled":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        // 实时事件是压缩状态的最新来源：之后才回来的快照不许把它盖掉。
        compactionEpochRef.current += 1;
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        compactionEpochRef.current += 1;
        setIsCompacting(false);
        // pi sends summarization_retry_finished first; a stream down for that
        // retry missed it, and its banner would stay above an idle composer.
        setRetryInfo(null);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadCompactedSession(sessionIdRef.current, event.reason === "manual");
        }
        break;
      case "bash_output": {
        // The wrapper's snapshot of a running `!` command's output tail.
        const output = event.output;
        if (!bashRunningRef.current || typeof output !== "string") break;
        // A slow stream may still carry the previous command's last snapshot.
        setPendingBash((pending) => (
          pending && !pending.result && pending.command === event.command ? { ...pending, liveOutput: output } : pending
        ));
        break;
      }
      case "editor_paste":
        if (typeof event.text === "string") opts.chatInputRef?.current?.pasteText(stripAnsi(event.text));
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed": {
        const id = event.id as string;
        setExtensionDialog((current) => current?.id === id ? null : current);
        if (extensionDialogRef.current?.id === id) extensionDialogRef.current = null;
        const wasAskRequest = askQuestionnaireRequestIdsRef.current.delete(id);
        // 提交问卷时，每道题完成都会关闭各自的底层 UI 请求；此时问卷仍需继续承接下一题。
        if (wasAskRequest && !askQuestionnaireRef.current?.submitting) clearAskQuestionnaire();
        break;
      }
    }
  }, [addNotice, cancelEventStreamGrace, updateQueuedMessages, clearAskQuestionnaire, closeEvents, markPromptLanded, onSessionEnded, opts.chatInputRef, consumeShadowEntry, dispatch, enqueueStreamDelta, enterMainRun, flushStreamDeltas, handleExtensionUiRequest, isNew, toolSelectionKnown, loadTools, loadCompactedSession, loadSession, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent, onSessionListRefresh, onToolEnd, reconcileAgentState, refreshContextUsage, resetStreamDeltas, scheduleContextRefresh, scheduleEventStreamClose, streamingStore]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], fromStash = false) => {
    if (!isNavigationActive(navigationKey)) return false;
    backfillRequestRef.current.controller?.abort();
    backfillRequestRef.current.generation += 1;
    const requestSessionId = sessionIdRef.current ?? session?.id ?? null;
    if (requestSessionId) invalidateSessionContext(requestSessionId);
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    // UI 状态可能晚于异步扩展启动的 agent_start；此时不可吞掉用户输入。
    const isBashCommand = !fromStash && !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand && bashRunningRef.current) {
      addNotice({ type: "warning", message: translate("chat.bashAlreadyRunning") });
      return false;
    }
    if ((agentRunningRef.current && !isBashCommand) || bashRunningRef.current) return false;
    // 暂存库发送的不是输入框正文：捕获这一刻的草稿，确认后迁移，不能顺带清掉等待期间的新输入。
    const capturedTransfer = fromStash && isNew && newSessionCwd ? captureDraftTransfer(`new:${newSessionCwd}`) : null;
    setSubmissionError(null);
    const activeCwd = session?.cwd ?? newSessionCwd;
    if (activeCwd) {
      // 分支信息只影响侧栏展示，不应阻塞会话创建、SSE 建连和首条 prompt。
      void fetch(`/api/git/context?cwd=${encodeURIComponent(activeCwd)}`, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok) return;
          console.error("刷新当前 Git 分支失败", await response.text());
        })
        .catch((error) => {
          console.error("刷新当前 Git 分支失败", error);
        });
    }
    if (editEntryId) {
      // Navigate and prompt are two RPCs: a prompt rejected after navigating
      // keeps the new leaf until the server can apply both atomically.
      const entryId = editEntryId;
      setEdit(null);
      if (!(await handleNavigateRef.current?.(entryId))) {
        setEdit(entryId);
        return false;
      }
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      return await executeBashRef.current?.(bashCmd, isExcluded) ?? false;
    }

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    // What the view holds before the bubble: its last saved entry, and the same
    // text already sent since (the run messages the stream added), for #1432.
    const userKey = userMessageKey(userMsg);
    const savedViewIds = entryIdsRef.current;
    const lastEntryIdAtSend = savedViewIds.at(-1) ?? null;
    const sameTextAfterSend = countUserMessages(messagesRef.current.slice(savedViewIds.length), userKey);
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userKey;
    const promptRunId = enterMainRun(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    requestScrollPosition("user");

    // A queued prompt (parked behind compaction, or queued into a run) is not a
    // sent message yet: the queue rows show it, and the transcript shows it when
    // the flush delivers it. Drop the optimistic bubble for it.
    const dropOptimisticUserMessage = () => {
      setMessages((prev) => {
        const index = prev.lastIndexOf(userMsg);
        return index === -1 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
      });
      optimisticUserMessageKeyRef.current = null;
    };
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;
    let firstPromptRequestStarted = false;

    try {
      // 草稿的切模型还没落地（档位要等推荐返回）：首条消息必须等它，否则会用新模型配旧档位。
      // 切走再回来重建的实例看不到旧实例的 ref，所以还等同 cwd 登记的那次切换。
      if (isNew) await awaitDraftModelSwitch();
      if (isNew && newSessionCwd && pendingControlKind === "staged") {
        // 首条消息交给服务端：只有创建 runtime 这一小段依赖页面，之后切走也会照常发送。
        const cwd = newSessionCwd;
        // 等切模的这段时间草稿还能改（模型、档位、Shadow 开关），改它的也可能是切走再回来重建的
        // 另一个实例：按等完后的最新草稿取值，不用等待前的那份闭包。
        const latest = currentNewSessionSettings();
        const selectedModel = latest.model;
        const selectedThinkingLevel = latest.thinkingLevel;
        const shadowMindEnabled = latest.shadowMindEnabled;
        onPendingNewSessionEvent(cwd, { type: "START" });
        // 会话文件在第一条消息发出前还没有模型记录，等待期间继续显示当前选择。
        if (displayModel) setPendingModel(displayModel);
        let sid: string;
        try {
          sid = await createNewSessionRuntime({
            cwd,
            toolNames: currentNewSessionToolNames(),
            shadowMindEnabled,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
            // 自动推荐只作用于这个会话：不能当成新的全局默认档位写回 settings.json。
            thinkingLevelExplicit: latest.thinkingLevelExplicit,
            thinkingLevelModel: latest.thinkingLevelModel,
            ...(fastEnabled && displayModelFastAvailable ? { fastEnabled: true } : {}),
          });
        } catch (error) {
          onPendingNewSessionEvent(cwd, { type: "REQUEST_FAIL", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        onPendingNewSessionEvent(cwd, { type: "RUNTIME_CREATED", sessionId: sid });
        try {
          if (isNavigationActive(navigationKey)) {
            sessionIdRef.current = sid;
            sentSessionId = sid;
            try {
              await ensureEventsConnected(sid);
            } catch (error) {
              // 切走会主动关闭这条 SSE；运行时身份已拿到，首发仍须交给服务端后台提交。
              if (isNavigationActive(navigationKey)) throw error;
            }
          }
          firstPromptRequestStarted = true;
          await submitNewSessionFirstPrompt({ cwd, sessionId: sid, message, images: piImages, shadowMindEnabled });
        } catch (error) {
          onPendingNewSessionEvent(cwd, { type: "POST_START_FAIL", sessionId: sid, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        const now = new Date().toISOString();
        if (!isNavigationActive(navigationKey)) {
          // staged 首发的后台成功分支不经过 promoteNewSession，也必须完成已捕获草稿的迁移。
          if (fromStash) capturedTransfer?.(sid);
          onSessionCreatedInBackground?.({ id: sid, path: "", cwd, created: now, modified: now, messageCount: 0, firstMessage: message });
          return true;
        }
        // 消息现在是队列行，真正发出时才进入对话。
        dropOptimisticUserMessage();
        promoteNewSession(0, message, fromStash, capturedTransfer);
        void loadTools(sid);
        const stagedRead = beginRuntimeRead();
        void fetchRuntimeState(sid, new AbortController().signal).then((snapshot) => {
          if (sessionIdRef.current === sid) applyRuntimeSnapshot(stagedRead, snapshot.state);
        }).catch((error: unknown) => {
          console.error("读取新会话 runtime 状态失败:", error);
        });
        return true;
      }
      if (isNew && newSessionCwd) {
        const alreadyMaterialized = pendingControlKind === "materialized";
        // 模型取创建时真正提交的那一份（ref），不取渲染闭包里的状态：发送前刚切过模型时闭包里
        // 还是上一个模型，之后补发的 set_model 会把已经切好的运行时又切回去。
        const selectedModel = newSessionModelOverrideRef.current ?? newSessionModel;
        const sid = await ensureNewSession();

        if (sid) {
          if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，消息未发送");
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (alreadyMaterialized) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，消息未发送");
          promptRequestStarted = true;
          const queuedAck = await sendAgentCommand<AgentSubmitAcknowledgement & { enabled?: boolean }>(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          if (fromStash && !queuedAck?.accepted && typeof queuedAck?.enabled !== "boolean") throw new Error(translate("chat.sendUnconfirmed"));
          if (queuedAck?.queued) dropOptimisticUserMessage();
          try {
            const runtimeState = await sendAgentCommand<AgentRuntimeState>(sid, { type: "get_state" });
            if (runtimeState.model && isThinkingLevel(runtimeState.thinkingLevel)) {
              void recordThinkingLevelPreference(runtimeState.model.id, runtimeState.thinkingLevel);
            }
          } catch (preferenceError) {
            console.error("[pi-web] 获取思考强度实际值失败:", preferenceError);
          }
          promoteNewSession(1, message, fromStash, capturedTransfer);
        }
      } else if (session) {
        const sid = requestSessionId;
        if (!sid || sid !== session.id) throw new Error("会话已切换，消息未发送");
        if (!isNavigationActive(navigationKey)) throw new Error("会话已切换，消息未发送");
        sentSessionId = sid;
        await ensureEventsConnected(sid);
        if (sessionIdRef.current !== sid || !isNavigationActive(navigationKey)) {
          throw new Error("会话已切换，消息未发送");
        }
        promptRequestStarted = true;
        const queuedAck = await sendAgentCommand<AgentSubmitAcknowledgement & { enabled?: boolean }>(sid, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        if (fromStash && !queuedAck?.accepted && typeof queuedAck?.enabled !== "boolean") throw new Error(translate("chat.sendUnconfirmed"));
        if (queuedAck?.queued) dropOptimisticUserMessage();
      }
      setPromptMissingCwd(null);
      if (isSlashCommandPrompt && sentSessionId) {
        void reconcileAgentState(sentSessionId, promptRunId);
      }
      return Boolean(sentSessionId);
    } catch (e) {
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      if (promptRequestStarted && sentSessionId && !isPromptRejectedError(e) && !(fromStash && e instanceof AgentCommandError && e.accepted === false)) {
        // 请求已发出但响应失败时，服务端可能已受理：气泡保留到服务端确认 idle，
        // 只有确认未收到时才把文字还回输入框，绝不重发（#1432）。
        if (fromStash) {
          // 暂存库保留原消息，避免对账时再复制一份到输入框。
          dropOptimisticUserMessage();
          void reconcileAgentState(sentSessionId, promptRunId);
          throw e;
        }
        if (landedPromptRunIdRef.current !== promptRunId) {
          unconfirmedSendRef.current = {
            runId: promptRunId,
            sid: sentSessionId,
            message,
            images,
            draftKey: sentSessionId,
            parkedDraftKey: isNew && newSessionCwd ? parkedNewSessionDraftKey(newSessionCwd) : null,
            lastEntryIdAtSend,
            sameTextAfterSend,
            bubble: userMsg,
            key: userKey,
            command: isSlashCommandPrompt,
          };
          if (!sessionHookMountedRef.current) releaseUnconfirmedSendRef.current();
        }
        void reconcileAgentState(sentSessionId, promptRunId);
        return true;
      }
      // A folder that no longer exists never reached the model: the composer's
      // banner names it (translated) instead of the server's English notice.
      if (e instanceof AgentCommandError && e.missingCwd) setPromptMissingCwd(e.missingCwd);
      agentRunningRef.current = false;
      // 本次等待失败不代表订阅失效；可恢复启动错误仍由底层重连，保留后续事件和弹窗。
      if (!(e instanceof EventStreamConnectionError && e.status === "startup_error" && e.retryable)) closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      const detail = e instanceof Error ? e.message : String(e);
      if (isNavigationActive(navigationKey)) setSubmissionError({ navigationKey, message: detail });
      if (!(e instanceof AgentCommandError && e.missingCwd)) addNotice({ type: "error", message: `消息发送失败，输入已保留：${detail}` });
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      resetStreamDeltas();
      dispatch({ type: "end" });
      if (fromStash && firstPromptRequestStarted && (e as { accepted?: boolean } | null)?.accepted !== false) throw e;
      return false;
    }
  }, [addNotice, applyRuntimeSnapshot, awaitDraftModelSwitch, beginRuntimeRead, closeEvents, currentNewSessionSettings, currentNewSessionToolNames, dispatch, displayModel, displayModelFastAvailable, editEntryId, ensureEventsConnected, ensureNewSession, enterMainRun, fastEnabled, loadTools, onPendingNewSessionEvent, onSessionCreatedInBackground, isNavigationActive, isNew, navigationKey, newSessionCwd, newSessionModel, pendingControlKind, promoteNewSession, reconcileAgentState, requestScrollPosition, resetStreamDeltas, session, setEdit, translate]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (bashRunningRef.current) return false;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    const startedAt = Date.now();
    setPendingBash({ command, excludeFromContext, startedAt });
    setBashRunning(true);
    let deferred: PendingBash | null = null;
    try {
      const sid = await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      // A `user_bash` handler's dialog (ctx.ui.confirm…) reaches the page only
      // through the stream, which a fresh composer has not opened yet. The
      // output streams through it too; without one it comes at the end.
      await ensureConnectedRef.current(sid).catch(() => {});
      const result = await sendAgentCommand<PendingBash["result"]>(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      if (agentRunningRef.current && result) {
        // pi writes it once the run ends; the card shows the output until then.
        deferred = { command, excludeFromContext, startedAt, result };
        // Only a read started after this one may take the card away.
        deferredBashReadSeqRef.current = sessionReadSeqRef.current;
      } else {
        await loadSession(sid);
        promoteNewSession(1, inputText);
      }
      return true;
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      if (!(e instanceof AgentCommandError && e.code === EXTENSION_REPORTED_CODE)) {
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return false;
    } finally {
      bashRunningRef.current = false;
      setPendingBash(deferred);
      setBashRunning(false);
      const idleRead = idleReadAfterBashRef.current;
      idleReadAfterBashRef.current = null;
      if (idleRead) idleMessageReadsRef.current?.(idleRead);
    }
  }, [addNotice, ensureNewSession, loadSession, promoteNewSession]);
  executeBashRef.current = executeBash;

  /** Stop 交还的排队消息（含附件）回到输入框；请求期间切走会话时只恢复到原会话草稿。 */
  const restoreRecalledPrompts = useCallback((sid: string, recalled: QueuedMessages | null | undefined) => {
    if (!recalled) return;
    const draft = queuedMessagesToDraft(recalled);
    const hasDraft = draft.value.length > 0 || draft.images.length > 0;
    if (!isNavigationActive(navigationKey) || sessionIdRef.current !== sid || !opts.chatInputRef?.current) {
      if (hasDraft) setDraft(sid, prependChatDraft(draft, getDraft(sid) ?? { value: "", images: [] }));
      return;
    }
    // 无 SSE 的会话也立即清除队列显示。
    updateQueuedMessages({ steering: [], followUp: [] });
    if (hasDraft) opts.chatInputRef.current.prependDraft(draft);
  }, [opts.chatInputRef, isNavigationActive, navigationKey, updateQueuedMessages]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Beside a run, Stop stops the run first, as Esc does in pi's TUI; the command next.
    if (bashRunningRef.current && !agentRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    let recall: (QueuedMessages & { blockedByCommands?: string[] }) | null = null;
    try {
      recall = await sendAgentCommand<QueuedMessages & { blockedByCommands?: string[] } | null>(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
      return;
    }
    // 扩展命令（/review 等）没有中止信号，Stop 停不了：说明现状并指向命令自己的取消入口，
    // 不能装作停掉了——挂起的 dialog 也还在等用户，不能跟着关掉。
    const blocked = recall?.blockedByCommands;
    if (blocked?.length) {
      addNotice({ type: "warning", message: translate("chat.stopBlockedByCommand", { command: commandNameOf(blocked[0]) ?? blocked[0] }) });
      // 命令照旧跑，但服务端已把等它的排队消息撤回：它们必须回到输入框，否则 Stop 之后还会
      // 在命令结束时发出去。队列显示清掉，草稿带附件一并恢复。
      restoreRecalledPrompts(sid, recall as QueuedMessages | null);
      return;
    }
    // 中止会话后不再等待用户输入，关闭挂起的 dialog 弹窗
    setExtensionDialog(null);
    extensionDialogRef.current = null;
    clearAskQuestionnaire();
    markManualStopNotificationSuppressed(sid);
    // Queued prompts come back for the composer, as Recall's do.
    restoreRecalledPrompts(sid, recall as QueuedMessages | null);
  }, [addNotice, clearAskQuestionnaire, restoreRecalledPrompts, translate]);

  const handleFork = useCallback(async (entryId: string, draft?: ChatDraft) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        if (draft) setDraft(newSessionId, draft);
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked]);

  /** 同一会话的导航串行执行，过期导航和扩展取消均不提交视图。 */
  const navigateToLeaf = useCallback((sid: string, leafId: string | null): Promise<boolean> => {
    const generation = ++navigationSequenceRef.current;
    navigationGenerationRef.current.set(sid, generation);
    const previous = navigationChainRef.current.get(sid) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (navigationGenerationRef.current.get(sid) !== generation || sessionIdRef.current !== sid) return false;
      if (leafId) {
        const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, { type: "navigate_tree", targetId: leafId });
        if (result?.cancelled) return false;
      }
      if (navigationGenerationRef.current.get(sid) !== generation || sessionIdRef.current !== sid) return false;
      const loaded = await loadContext(sid, leafId);
      return loaded && navigationGenerationRef.current.get(sid) === generation && sessionIdRef.current === sid;
    }).catch((error) => {
      if (navigationGenerationRef.current.get(sid) === generation) console.error("Failed to navigate session:", error);
      return false;
    });
    const queued = operation.then(() => {});
    navigationChainRef.current.set(sid, queued);
    void queued.finally(() => {
      if (navigationChainRef.current.get(sid) !== queued) return;
      navigationChainRef.current.delete(sid);
      navigationGenerationRef.current.delete(sid);
    });
    return operation;
  }, [loadContext]);
  const handleNavigate = useCallback(async (entryId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || bashRunningRef.current || agentRunningRef.current || isCompacting) return false;
    return navigateToLeaf(sid, entryId);
  }, [isCompacting, navigateToLeaf]);
  handleNavigateRef.current = handleNavigate;
  const handleLeafChange = useCallback(async (leafId: string | null) => {
    const sid = sessionIdRef.current;
    if (!sid || bashRunningRef.current || agentRunningRef.current || isCompacting) return;
    await navigateToLeaf(sid, leafId);
  }, [isCompacting, navigateToLeaf]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      if (creationSettingsLocked || modelSwitchPendingRef.current) return;
      const selectedModel = { provider, modelId };
      const sameModel = displayModel?.provider === provider && displayModel.modelId === modelId;
      const sid = sessionIdRef.current;
      modelSwitchPendingRef.current = true;
      setModelSwitching(true);
      // 同一草稿的切模按 cwd 记版本：切走再回来重建的实例可能各自起一次切换，先发起的那次
      // 晚结算时不能把用户后来选的模型又写回草稿。
      const switchVersion = newSessionCwd ? beginDraftModelSwitch(newSessionCwd) : null;
      // 发起时的档位修订号：提交时草稿的修订号对不上，说明期间有人在（很可能是另一个实例里）
      // 手动改过档，这一次就只提交模型，把用户刚选的那一档留给草稿。
      const startLevelRevision = settingsLevelRevision(newSessionCwd ? latestPendingNewSessionControl(newSessionCwd) : null)
        ?? settingsLevelRevision(pendingNewSessionControlRef.current)
        ?? 0;
      // 档位是异步查出来的（pin → 这个模型的常用档位 → 旧档位限幅），首条消息和其它创建入口
      // 必须等这次切换落地，否则会拿着新模型 + 旧档位创建会话。在途任务同时挡住重复点击。
      const switching = (async (): Promise<DraftModelSelection | null> => {
        if (sid) {
          // 已创建但未发送的会话，以服务端切换成功作为选择器提交条件。
          try {
            await sendAgentCommand(sid, { type: "set_model", provider, modelId });
          } catch (e) {
            console.error("Failed to set model:", e);
            addNotice({ type: "error", message: `切换模型失败：${e instanceof Error ? e.message : String(e)}` });
            return null;
          }
          if (!isNavigationActive(navigationKey) || sessionIdRef.current !== sid) return null;
        }
        newSessionModelOverrideRef.current = selectedModel;
        // 切模型时档位跟着新模型走（pin → 最近用过的众数 → 旧档位限幅），上一个模型的手动选择不再沿用；
        // 重选同一个模型（为了应用 models.json 的修改）保持用户刚选的档位。
        // 已经有运行时的暂存会话由服务端在 set_model 里定档（settings.json 的按模型档位优先），不在这里推算。
        const selection = await modelSelectionActions.selectNewSessionModel(selectedModel, { preserveLevel: sameModel || Boolean(sid) });
        // 同一草稿上又起了新的切换：这次的选择已经作废，什么都不提交。
        if (selection.status === "superseded") return null;
        // 本实例的选择也被更新的一次取代（例如重选之后又选了别的）。
        if (newSessionModelOverrideRef.current !== selectedModel) return null;
        // 解析出的档位：已有运行时（暂存会话）取服务端定下的那一档，没有运行时用本地推荐。
        let draftLevel: ThinkingLevelOption = thinkingLevelOverrideRef.current ?? recommendedThinkingLevelRef.current ?? "auto";
        let thinkingLevelSource: ThinkingLevelSource = thinkingLevelOverrideRef.current === null ? "auto" : "manual";
        if (!sameModel) {
          if (sid) {
            const read = beginRuntimeRead();
            const snapshot = await readAgentSnapshot(sid);
            if (snapshot?.state && sessionHookMountedRef.current && sessionIdRef.current === sid) {
              // 快照可能早于用户刚改的档位：这份快照的档位被跳过时不能把它写进草稿，
              // 否则界面显示旧档位、运行时用的却是新档位。
              const adoption = applyRuntimeSnapshot(read, snapshot.state);
              if (adoption.thinking) {
                draftLevel = parseThinkingLevelOption(snapshot.state.thinkingLevel);
                thinkingLevelSource = "auto";
                thinkingLevelOverrideRef.current = null;
              }
            }
          } else if (selection.status === "applied") {
            thinkingLevelOverrideRef.current = null;
            draftLevel = selection.preferredThinking ?? "auto";
            thinkingLevelSource = "auto";
            recommendedThinkingLevelRef.current = selection.preferredThinking ?? null;
          }
          // status 为 "manual"（切模期间用户手动选了档）时保留用户刚选的那一档：模型照样提交，
          // 否则草稿只留下档位、模型还停在上一个。
        }
        // 提交前再核对一次：同一草稿上已有更新的一轮切换时，这次结果作废。
        if (newSessionCwd && switchVersion !== null && !isLatestDraftModelSwitch(newSessionCwd, switchVersion)) {
          return null;
        }
        let committed: DraftModelSelection = { model: selectedModel, thinkingLevel: draftLevel, thinkingLevelSource };
        let levelRevisionAtStart = startLevelRevision;
        const latestControl = newSessionCwd ? latestPendingNewSessionControl(newSessionCwd) : null;
        if (latestControl && "model" in latestControl && (latestControl.levelRevision ?? 0) !== startLevelRevision) {
          // 期间有人在另一个实例里手动选了档：状态机会保留那一档，这里交回去的也必须是它，
          // 否则等待方写回选择器的还是这次的推荐值。选择保留，但要按**目标模型**限幅——
          // 界面此刻还按切之前的模型给选项，A 支持 max 而 B 最高只到 high 时，不折中就会把
          // 一个 B 做不到的档位写进草稿和创建请求。
          const supported = thinkingLevelsRef.current[`${selectedModel.provider}:${selectedModel.modelId}`] ?? null;
          const picked = latestControl.thinkingLevel;
          committed = {
            model: selectedModel,
            thinkingLevel: picked === "auto" ? picked : clampThinkingLevelToSupported(picked, supported),
            thinkingLevelSource: latestControl.thinkingLevelSource,
          };
          // 修订号取读草稿的这一刻：提交里带的已经是限幅后的值，让 reducer 接受同一份；仍用
          // 发起时的旧修订号，它会把那次手写的原始值（B 做不到的 max）保留下来。
          levelRevisionAtStart = latestControl.levelRevision ?? levelRevisionAtStart;
        }
        // 模型和档位在同一次草稿事件里提交：只提交模型会留下一段「新模型 + 旧档位」的窗口，
        // 用户正好在这时切走再回来，重建的组件就会把旧档位套到新模型上。
        if (newSessionCwd) {
          onPendingNewSessionEvent(newSessionCwd, { type: "SET_MODEL", ...committed, levelRevisionAtStart });
        }
        setPendingModel(selectedModel);
        return committed;
      })();
      // 创建入口只等它落地：档位解析本身出错不该把首条消息一起拒掉。
      const settled = switching.catch((error: unknown): DraftModelSelection | null => {
        console.error("[pi-web] 草稿切换模型失败:", error);
        return null;
      });
      draftModelSwitchRef.current = { version: switchVersion ?? 0, task: settled };
      // 同 cwd 登记的副本给重建出来的实例用：它看不到这边的 ref，只能按 cwd 找到这次切换。
      if (newSessionCwd && switchVersion !== null) registerDraftModelSwitch(newSessionCwd, switchVersion, settled);
      try {
        await settled;
      } finally {
        if (draftModelSwitchRef.current?.task === settled) draftModelSwitchRef.current = null;
        if (newSessionCwd && switchVersion !== null) settleDraftModelSwitch(newSessionCwd, switchVersion);
        modelSwitchPendingRef.current = false;
        setModelSwitching(false);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    // A switch during a run applies from the run's next model request, as the
    // reasoning level does. Reading the file then would swap the run's messages
    // under the stream, so take the model and level from the live state; the
    // run's end reads the file.
    const midRun = agentRunningRef.current || bashRunningRef.current;
    const syncLiveState = async () => {
      const read = beginRuntimeRead();
      const snapshot = await readAgentSnapshot(sid);
      if (snapshot?.state && sessionHookMountedRef.current && sessionIdRef.current === sid) {
        applyRuntimeSnapshot(read, snapshot.state);
      }
    };
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      // 档位由服务端在 set_model 里按「settings.json 的按模型档位 → enabledModels pin →
      // 最近用过的众数 → 切换前的档位」定下来（rpc-manager 的 applyModelDefaultThinking），
      // 这里之后的 reload / syncLiveState 读回来的就是它的结果。
      modelSwitchPendingRef.current = false;
      if (midRun) {
        setCurrentModelOverride(null);
        await syncLiveState();
      } else {
        invalidateSessionContext(sid);
        await loadSession(sid, false, true);
      }
    } catch (e) {
      console.error("Failed to switch model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      if (midRun) {
        await syncLiveState();
      } else {
        invalidateSessionContext(sid);
        await loadSession(sid, false, true);
      }
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [applyRuntimeSnapshot, beginRuntimeRead, readAgentSnapshot, addNotice, creationSettingsLocked, currentModelOverride, displayModel, isNavigationActive, isNew, loadSession, modelSelectionActions, navigationKey, newSessionCwd, onPendingNewSessionEvent]);

  /**
   * Manual compaction (the Compact button and `/compact`). Never awaited by a
   * caller that holds the composer: the compact POST is blocking and lasts the
   * whole compaction, and `runBuiltinCommand` keeps the composer's fieldset
   * disabled until the command resolves. The compaction reports itself — the
   * Compacting status, Stop compaction, the result banner and its error.
   */
  /** Resolves false when the compaction failed. */
  const handleCompact = useCallback(async (customInstructions?: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return true;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      });
      setCompactResult(readCompactResult(result, "manual"));
      if ((await loadCompactedSession(sid, true)).loaded) promoteNewSession();
      return true;
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
      return false;
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadCompactedSession, promoteNewSession]);

  // The banner otherwise stays until the next compaction, e.g. "Nothing to compact".
  const dismissCompactError = useCallback(() => setCompactError(null), []);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const draftControl = isNew && !sessionIdRef.current ? currentDraftControl() : null;
    const draftSettings = draftControl && "model" in draftControl ? draftControl : null;
    // 草稿跟着默认模型、档位又是自动推荐时，每次加载都重新算：默认模型可能已经换人，旧推荐
    // 属于上一个模型，创建请求会把它连同新默认模型一起发出去（限幅也纠不回归属）。
    // 草稿自己选了模型或有手动档位时不算，别拿默认模型的推荐覆盖它。
    const followsDefault = Boolean(draftControl)
      && !draftSettings?.model
      && draftSettings?.thinkingLevelSource !== "manual";
    const recommendation: { model: SelectedModel | null } = { model: null };
    const preferredThinking = await modelSelectionActions.load({
      cwd: newSessionCwd ?? session?.cwd ?? "",
      initializeNewSession: isNew && !sessionIdRef.current,
      applyPinnedThinking: !explicitAutoThinkingRef.current
        && thinkingLevelOverrideRef.current === null
        && (recommendedThinkingLevelRef.current === null || followsDefault),
      onPreferredThinking: (model) => { recommendation.model = model; },
      signal,
    });
    // The maps replace the ones loadAllModels merged into: load that list again.
    setAllModelList(null);
    allModelsLoadRef.current = null;
    if (!isNew || sessionIdRef.current) return;
    if (thinkingLevelOverrideRef.current !== null) return;
    // `undefined` = 这次加载不适用或已被切模型取代，别把它当成"没有推荐"清掉刚切到的推荐；
    // `null` = 适用但没有推荐值，旧推荐（可能属于上一个默认模型）要一起作废。
    if (preferredThinking === undefined) return;
    recommendedThinkingLevelRef.current = preferredThinking;
    if (!newSessionCwd) return;
    // 这份推荐会显示在输入框里，就得和创建请求一致：写进草稿，否则创建请求会省掉
    // thinkingLevel，服务端按 settings 的默认档位开跑——历史推荐与默认档位不同时，
    // 首条消息用的档位和界面显示的不是一个。用户主动选的 `auto`（manual）不覆盖：那是
    // "交给服务端定"。
    const latestDraft = currentDraftControl();
    const latestSettings = "model" in latestDraft ? latestDraft : null;
    if (!latestSettings || latestSettings.thinkingLevelSource === "manual") return;
    // 取推荐期间草稿可能已经切到别的模型：那一档属于它自己，别用默认模型的推荐盖掉。
    if (latestSettings.model) return;
    const next = preferredThinking ?? "auto";
    if (latestSettings.thinkingLevel === next
      && latestSettings.recommendationModel?.provider === recommendation.model?.provider
      && latestSettings.recommendationModel?.modelId === recommendation.model?.modelId) return;
    onPendingNewSessionEvent(newSessionCwd, { type: "SET_THINKING_LEVEL", level: next, source: "auto", recommendationModel: recommendation.model });
  }, [currentDraftControl, isNew, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent, session?.cwd]);

  // pi's /model "all" scope: names and reasoning levels of models outside
  // `enabledModels` join the maps, so a picked unscoped model shows them too.
  const loadAllModels = useCallback(() => {
    if (allModelsLoadRef.current) return;
    const load = {};
    allModelsLoadRef.current = load;
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    fetch(`/api/models?scope=all${modelCwd ? `&cwd=${encodeURIComponent(modelCwd)}` : ""}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load models (HTTP ${res.status})`);
        const d = await res.json() as { models?: Record<string, string>; modelList?: ModelEntry[]; thinkingLevels?: Record<string, ThinkingLevel[]>; thinkingLevelMaps?: Record<string, ThinkingLevelMap> };
        if (allModelsLoadRef.current !== load) return;
        modelSelectionActions.mergeCatalog({ names: d.models ?? {}, thinkingLevels: d.thinkingLevels ?? {}, thinkingLevelMaps: d.thinkingLevelMaps ?? {} });
        setAllModelList(d.modelList ?? []);
      })
      .catch((e) => {
        if (allModelsLoadRef.current !== load) return;
        allModelsLoadRef.current = null;
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }, [addNotice, modelSelectionActions, newSessionCwd, session?.cwd]);




  /**
   * Fork this session into a side chat and open its tab: `/side` and the selected-text
   * popover. `prompt` is its first message, `name` what to call it instead of that
   * message's first line. Answers the refusal to show, or null.
   */
  const startSideChat = useCallback(async (prompt: string | null, name?: string): Promise<string | null> => {
    // The route refuses these too; a tab has nowhere to open another tab from.
    const relationKind = opts.session?.relation?.kind;
    if (relationKind === "side" || relationKind === "subagent") return translate(SIDE_REFUSAL_MESSAGES[relationKind]);
    // Unlike the other built-ins, no ensureNewSession(): forking a session
    // that does not exist yet has nothing to inherit.
    const sourceId = sessionIdRef.current;
    if (!sourceId) return translate("sideChat.error.noSession");
    const result = await createSideChat(sourceId, translate, name);
    if ("error" in result) return result.error;
    onSideSession?.(result.session, prompt);
    return null;
  }, [onSideSession, opts.session?.relation?.kind, translate]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (!result.action) {
        // A command that opens a panel says nothing: the panel is the answer.
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          // Detached on purpose. This must resolve now: runBuiltinCommand holds
          // the composer's fieldset disabled until the command resolves, and the
          // compact POST blocks for the whole compaction, which read as an input
          // box that stopped taking text until the session was switched away and
          // back. The compaction reports itself (Compacting status, Stop
          // compaction, result banner, error), so no completion notice here.
          // A failed compaction gives its instructions back, as the awaited command
          // left them in the composer.
          void handleCompact(args || undefined).then((compacted) => {
            if (!compacted && args) opts.chatInputRef?.current?.prependText(`/compact ${args}`);
          });
          return complete({ handled: true, action: "compact" });
        }

        case "auto-compact": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          // Read the live wrapper (this POST starts it if idle) so the toggle
          // follows settings.json, not the React default of `true`.
          const liveState = await sendAgentCommand<AgentRuntimeState>(sid, { type: "get_state" });
          const nextEnabled = !(liveState?.autoCompactionEnabled ?? true);
          await sendAgentCommand(sid, {
            type: "set_auto_compaction",
            enabled: nextEnabled,
          });
          return complete({
            handled: true,
            message: nextEnabled
              ? "Auto-compaction enabled"
              : "Auto-compaction disabled",
          });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if ((await loadSession(sid)).loaded) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          if (!onSessionStatsPanelOpen) return complete({ handled: true, message: formatSessionSummary(sessionStatsRef.current, translate) });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "shadow": {
          const shadowResult = await runShadowSlashCommand(text, sid);
          if (!shadowResult.handled) return { handled: false };
          if (!shadowResult.success) return complete({ handled: true, error: shadowResult.error });
          return complete({ handled: true, message: shadowResult.message });
        }
        case "mcp": {
          // Only a bare /mcp, and only when pi's built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          // copyText falls back to execCommand where navigator.clipboard is
          // missing: a page served over plain HTTP from a LAN address.
          await copyText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot clone while the session is running" });
          }
          const result = await sendAgentCommand<{ cancelled?: boolean; byExtension?: boolean; newSessionId?: string }>(sid, {
            type: "clone",
            leafId: activeLeafId,
          });
          if (result.byExtension) return { handled: true };
          if (result.cancelled || !result.newSessionId) {
            return complete({ handled: true, error: "Cannot clone an empty or unsaved session" });
          }
          const completed = complete({ handled: true, message: "Cloned current session branch" });
          onSessionForked?.(result.newSessionId);
          return completed;
        }

        case "side": {
          const error = await startSideChat(args || null);
          return complete(error ? { handled: true, error } : { handled: true, action: "openSideChat" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    }
  }, [startSideChat, activeLeafId, addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, onSessionForked, promoteNewSession, onSessionStatsPanelOpen, runShadowSlashCommand, onOpenSettings, slashCommandsForMcp, handleCompact, opts.chatInputRef, translate]);

  // 运行中提交统一走确认式契约：只有服务端确认 Pi 已接受后才允许输入框清空。
  // 斜杠命令需要保留 prompt 的模板展开语义，普通文本则使用原生 steer/followUp 队列。
  const handleQueuedSubmit = useCallback(async (
    message: string,
    mode: "steer" | "followUp",
    images?: AttachedImage[],
    fromStash = false,
  ): Promise<boolean> => {
    if (!isNavigationActive(navigationKey)) return false;
    const sid = sessionIdRef.current;
    if (editEntryId) {
      addNotice({ type: "error", message: "历史消息编辑需要等待当前运行结束" });
      return false;
    }
    if (!sid) {
      addNotice({ type: "error", message: "当前会话尚未就绪，消息未发送" });
      return false;
    }
    if (!images?.length) {
      const shadowResult = await runShadowSlashCommand(message, sid);
      if (shadowResult.handled) {
        if (!shadowResult.success) addNotice({ type: "error", message: shadowResult.error });
        return shadowResult.success;
      }
    }
    const piImages = images?.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    }));
    const command = message.startsWith("/")
      ? { type: "prompt", message, streamingBehavior: mode, ...(piImages?.length ? { images: piImages } : {}) }
      : { type: mode === "steer" ? "steer" : "follow_up", message, ...(piImages?.length ? { images: piImages } : {}) };
    try {
      if (!isNavigationActive(navigationKey)) return false;
      const acknowledgement = await sendAgentCommand<AgentSubmitAcknowledgement>(sid, command);
      if (!acknowledgement?.accepted) throw new Error("服务端未确认接收消息");
      // 命令可能已经开始跑（不进模型回合）：读一次状态，让「执行命令中：/…」立刻出现。
      if (command.type === "prompt") void reconcileAgentState(sid, promptRunIdRef.current);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (fromStash && !(error instanceof AgentCommandError && (error.accepted === false || error.status === 404 || error.status === 413))) throw error;
      addNotice({ type: "error", message: `消息发送失败，输入已保留：${detail}` });
      return false;
    }
  }, [addNotice, editEntryId, isNavigationActive, navigationKey, runShadowSlashCommand, reconcileAgentState]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !isNavigationActive(navigationKey) || !opts.chatInputRef?.current) return;
    try {
      const result = await sendAgentCommand<QueuedMessages>(sid, { type: "clear_queue" });
      const draft = queuedMessagesToDraft(result);
      // 移回请求期间切换会话，附件只能恢复到原会话草稿，不能插入新会话。
      if (!isNavigationActive(navigationKey) || sessionIdRef.current !== sid || !opts.chatInputRef?.current) {
        if (draft.value || draft.images.length > 0) {
          setDraft(sid, prependChatDraft(draft, getDraft(sid) ?? { value: "", images: [] }));
        }
        return;
      }
      // 无 SSE 的空闲会话也立即清除队列显示。
      updateQueuedMessages({ steering: [], followUp: [] });
      if (draft.value || draft.images.length > 0) {
        opts.chatInputRef?.current?.prependDraft(draft);
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice, isNavigationActive, navigationKey, updateQueuedMessages]);

  /**
   * 首屏加载成功后按快照恢复运行态：运行中的回合或扩展命令、bash 结算、后台子代理监听。
   * 首次加载与错误页重试共用这一份，否则重试成功后会话会一直显示空闲——命令在跑的时候
   * SSE 建连本身并不会把界面标记为运行中。
   */
  const restoreRuntimeFromLoad = useCallback((
    sid: string,
    agentState: AgentRuntimeSnapshot | null | undefined,
    read?: RuntimeRead | null,
  ) => {
    if (!agentState?.alive) return;
    loadTools(sid);
    const runtimeState = agentState.state;
    // 界面已经接管主回合（后续消息开始流式输出）时不能再按旧快照重设阶段：`enterMainRun`
    // 会把阶段改回「执行命令中」并清空正在渲染的流式回复。更新的快照说了空闲也一样。
    const takenOver = agentRunningRef.current
      || (read != null && lastAppliedRuntimeSeqRef.current > read.seq && runtimeBusySnapshotRef.current === false);
    if (!takenOver && agentState.busy && runtimeState && !runtimeState.isBashRunning) {
      requestScrollPosition("running-end");
      enterMainRun(runtimeState.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
      void connectEvents(sid);
    }
    if (runtimeState?.isBashRunning) {
      bashRunningRef.current = true;
      setBashRunning(true);
      void waitForBashSettlement(sid);
    }
    if (!agentRunningRef.current && pendingDetachedSubagentIdsRef.current.size > 0) {
      // 刷新后只恢复后台监听，不能把 detached 子代理显示成主代理思考。
      void connectEvents(sid);
    }
  }, [connectEvents, enterMainRun, loadTools, requestScrollPosition, waitForBashSettlement]);

  /**
   * 外部写入把 /context 挡在外面时，队列里只存在服务器内存中的消息先取回来，再重新加载：
   * 队列清空后 wrapper 才能被淘汰，/context 也才能重新读盘。取回的正文与附件进草稿，
   * 所以刷新后输入框里仍有它们。
   */
  const handleRecallBlockedQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setRecallError(null);
    try {
      const result = await sendAgentCommand<QueuedMessages>(sid, { type: "clear_queue" });
      const draft = queuedMessagesToDraft(result);
      // 草稿是这份正文唯一的一份了（草稿存储只在内存里）：读盘再失败也不能把它清掉。
      if (draft.value || draft.images.length > 0) {
        setDraft(sid, prependChatDraft(draft, getDraft(sid) ?? { value: "", images: [] }));
        markDraftRestorePending(sid);
        // 请求往返期间用户可能已经切走再切回：正文由存储保管，正在挂载的输入框接到通知就把
        // 它并进来，否则下一次编辑会拿本地内容把这个键覆盖掉。
        notifyRecalledDraft(sid, draft);
      }
      // 这个实例已经卸载：界面交给新的那个实例，重读也由它来做。
      if (!mountedRef.current) return;
      // 队列已经在服务端清空：在途的预读／状态查询都不许把它写回来。
      queueStateGenerationRef.current += 1;
      updateQueuedMessages({ steering: [], followUp: [] });
      setBlockedRecall(null);
      setRecalledPending(true);
      setError(null);
      // 必须让服务端复验：带缓存的首屏会直接提交旧内容并清掉恢复状态，之后的后台复验只记日志。
      const reloaded = await loadSession(sid, true, true, { validateView: true });
      // 移回之后同样要恢复运行态：命令还在跑时建连不会把界面标记成运行中，
      // 丢掉这份快照就会让仍在执行的 `/review` 显示成空闲。
      if (mountedRef.current && sessionIdRef.current === sid) {
        restoreRuntimeFromLoad(sid, reloaded.agentState, reloaded.runtimeRead);
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      // 错误页盖住了 NoticeShelf，原因要写在这里，否则用户只看到「取回没反应」。
      if (mountedRef.current) setRecallError(e instanceof Error ? e.message : String(e));
    }
  }, [loadSession, restoreRuntimeFromLoad, updateQueuedMessages]);

  /** 文件稳定后重新读一次：仍然保留取回后的草稿状态，不让用户为此刷新页面。 */
  const handleRetryBlockedLoad = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setError(null);
    void loadSession(sid, true, true, { validateView: true }).then(({ agentState, runtimeRead }) => {
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      restoreRuntimeFromLoad(sid, agentState, runtimeRead);
    });
  }, [loadSession, restoreRuntimeFromLoad]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (creationSettingsLocked) return;
    if (isNew && !sessionIdRef.current) {
      explicitAutoThinkingRef.current = level === "auto";
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
      // 用户自己挑的档位记成 manual：草稿切走再回来仍然算“显式选择”，不会被当成自动推荐。
      if (newSessionCwd) onPendingNewSessionEvent(newSessionCwd, { type: "SET_THINKING_LEVEL", level, source: "manual" });
      recommendedThinkingLevelRef.current = null;
    }
    if (level === "auto") {
      // 活动会话的 Auto 不写入运行时；新会话显示 settings.json 的解析默认值。
      if (isNew) modelSelectionActions.setThinkingLevel("auto");
      return;
    }
    // 输入栏此刻已经可用：在建的快照可能取到切换之前的档位，先让它们的档位字段失效，
    // 否则确认之后的响应回来会把选择器写回旧值。这一次选择的版本也记下来：连续改档时
    // 只有最新的那次能在确认阶段落地。
    thinkingChoiceRevisionRef.current += 1;
    const revision = thinkingChoiceRevisionRef.current;
    modelSelectionActions.setThinkingLevel(level);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const request = sendAgentCommand(sid, { type: "set_thinking_level", level });
      const settlement = request.then(() => undefined, () => undefined);
      thinkingChangeRequestsRef.current.add(settlement);
      try {
        await request;
      } finally {
        thinkingChangeRequestsRef.current.delete(settlement);
      }
      // 期间又选了别的档：这次确认已经过时——写回界面会让选择器退回旧值，推进版本还会
      // 让后一次选择之后发出的读取失效。
      if (sessionIdRef.current !== sid || thinkingChoiceRevisionRef.current !== revision) return;
      // 请求期间发出的读取可能采到改档之前的值：确认时再推进一次版本，让它们失效。
      thinkingChoiceRevisionRef.current += 1;
      modelSelectionActions.setThinkingLevel(level);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      // 最新一次选择没写进服务端：选择器还显示着它，运行时用的却是之前那一档。等在途的改档
      // 请求全部结算后按服务端实际值回填；期间用户又改过档就放弃（那次会有自己的结论）。
      const failedRevision = thinkingChoiceRevisionRef.current;
      if (!mountedRef.current || sessionIdRef.current !== sid || failedRevision !== revision) return;
      void (async () => {
        await Promise.allSettled([...thinkingChangeRequestsRef.current]);
        // 页面可能已经卸载、会话可能已经关闭：再发一次状态请求会把已关闭的会话从磁盘重新拉起来。
        if (!mountedRef.current || sessionIdRef.current !== sid) return;
        if (thinkingChoiceRevisionRef.current !== failedRevision) return;
        // 与常规快照共用读取序号：这份补读可能在别的标签页（或本页的重连补读）已经显示过
        // 更新的档位之后才回来，那样它写回的就是旧值。
        const read = beginRuntimeRead();
        // 只读的 `/state`：它不会为没有存活的会话创建 runtime。
        const snapshot = await fetchRuntimeState(sid, new AbortController().signal).catch(() => null);
        if (!mountedRef.current || sessionIdRef.current !== sid) return;
        if (thinkingChoiceRevisionRef.current !== failedRevision) return;
        // 只看档位自己的序号：这份补读没取队列和压缩状态，不能让它们也判成过期。
        if (read.seq <= lastAppliedThinkingSeqRef.current) return;
        // 只回填思考档位：整份快照还会写 Fast、队列等字段，用户的其它选择（例如刚确认的
        // Fast 开关）会被这份更早的取样覆盖回去。
        const level = snapshot?.state?.thinkingLevel;
        if (!isThinkingLevel(level)) return;
        // 只推进档位自己的序号，不推进用户选择的版本：这次补读是服务端值的回读，不该让
        // 之后发出的读取失效——别的标签页随后改档、本页重连读到的更新档位必须还能生效。
        lastAppliedThinkingSeqRef.current = read.seq;
        if (sessionIdRef.current) runtimeThinkingLevelSessionRef.current = sessionIdRef.current;
        modelSelectionActions.setThinkingLevel(level);
      })();
    }
  }, [beginRuntimeRead, creationSettingsLocked, isNew, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent]);


  const handleFastEnabledChange = useCallback(async (enabled: boolean) => {
    if (creationSettingsLocked || fastPending) return;
    const sid = sessionIdRef.current;
    if (!sid) {
      setFastEnabled(enabled);
      return;
    }
    setFastPending(true);
    try {
      const result = await sendAgentCommand<{ enabled: boolean; available: boolean }>(sid, { type: "set_fast_enabled", enabled });
      setFastEnabled(result.enabled);
      setRuntimeFastAvailable(result.available);
    } catch (error) {
      console.error("Failed to set Fast mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setFastPending(false);
    }
  }, [addNotice, creationSettingsLocked, fastPending]);
  // 卸载后迟到的取回结果只写存储、不再碰界面（那个实例已经不是当前会话了）。
  // 队列查询的代号：取回通知到达时递增，让还没回来的那次查询结果作废。
  const blockedRecallRequestRef = useRef(0);
  // 队列状态的代次：取回清空队列或开始新一轮加载时推进，旧的状态快照据此失效。
  const queueStateGenerationRef = useRef(0);
  // 压缩状态的代次（compaction_start / compaction_end 推进）：旧快照不许覆盖实时压缩状态。
  const compactionEpochRef = useRef(0);
  // 运行态快照的读取序号：较新的快照提交后，更早的响应也不许再覆盖压缩状态
  // （压缩可能发生在预读取样之后、SSE 开始监听之前，那时没有事件推进代次）。
  const runtimeReadSeqRef = useRef(0);
  // 已采纳的读取序号按字段各记一份：一份只更新思考档位的补读如果推进了整份快照的序号，
  // 更早发出、更晚返回的重连快照就会把队列和压缩状态一起当成过期而跳过。
  const lastAppliedRuntimeSeqRef = useRef(0);
  const lastAppliedQueueSeqRef = useRef(0);
  const lastAppliedThinkingSeqRef = useRef(0);
  // setStatus/setWidget 包括删除事件都推进版本，旧快照不能把已清理的扩展 UI 带回来。
  const extensionStatusesRevisionRef = useRef(0);
  const extensionWidgetsRevisionRef = useRef(0);
  // 删除键也保留版本，防止在途快照复活；其它键仍由重连补读修正。
  const extensionStatusKeyRevisionsRef = useRef(new Map<string, number>());
  const extensionWidgetKeyRevisionsRef = useRef(new Map<string, number>());
  // 已经读到过运行态思考强度的会话：上下文的档位对它们只是回退值。
  const runtimeThinkingLevelSessionRef = useRef<string | null>(null);
  // 最近一次绑定轮询发起时的读取坐标（轮询是串行的，任何时刻最多一个在途请求）。
  const bindingPollReadRef = useRef<RuntimeRead | null>(null);
  // 用户档位选择的版本：确认之后，切换之前取的快照不许把选择器写回旧档位。
  const thinkingChoiceRevisionRef = useRef(0);
  // 在途的改档请求：最新一次失败时要等它们结算，才能按服务端实际档位回填。
  const thinkingChangeRequestsRef = useRef(new Set<Promise<void>>());
  // 最近一次被采纳的快照给出的「有没有主回合在跑」：比旧快照说了空闲时，不再按旧快照开回合。
  const runtimeBusySnapshotRef = useRef<boolean | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Strict Mode 会多跑一次 setup/cleanup：清理后必须在 setup 里恢复，否则这个仍然挂着的
    // 实例会以为自己是旧的，取回成功后直接返回。
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 切走再切回来会重新挂载：恢复状态按会话 ID 存在草稿存储里，这里把它读回来，
  // 否则错误页只剩服务端那句「刷新」，而刷新正好丢掉刚取回的消息。
  useEffect(() => {
    const sid = sessionIdRef.current ?? "";
    setRecalledPending(hasPendingDraftRestore(sid));
    if (!sid) return;
    // 取回请求可能在新实例挂载之后才返回（发起它的是已经卸载的旧实例）：那时队列已经清空，
    // 这里立刻转成「已取回」状态，否则错误页还叫着「请刷新」，而刷新会丢掉这份草稿。
    return subscribeDraftRestore(sid, () => {
      // 队列已经由取回请求清空了：迟到的状态查询与预读都不能把它写回来。
      blockedRecallRequestRef.current += 1;
      updateQueuedMessages({ steering: [], followUp: [] });
      setRecalledPending(true);
      setBlockedRecall(null);
      // 通知可能晚于取回之后新入队的消息：清空只针对已取回的那批，随后按最新状态补一次查询，
      // 期间若又有实时更新到达，这次查询就作废（别把新队列盖掉）。
      const generation = queueStateGenerationRef.current + 1;
      queueStateGenerationRef.current = generation;
      void fetchRuntimeState(sid, new AbortController().signal)
        .then((snapshot) => {
          if (sessionIdRef.current !== sid || queueStateGenerationRef.current !== generation) return;
          const queued = normalizeQueuedMessages(snapshot?.state?.queuedMessages);
          updateQueuedMessages(queued);
          // 取回之后又有新消息入队时，错误页要重新拿到「移回」入口。
          setBlockedRecall(queued.steering.length > 0 || queued.followUp.length > 0 ? queued : null);
        })
        .catch(() => undefined);
    });
  }, [session?.id, updateQueuedMessages]);

  const toolSelectionPendingRef = useRef(false);
  /** 只读菜单每次打开都重读激活名单：运行中扩展、Shadow 开关都会改服务端那边的工具。 */
  const refreshTools = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) void loadTools(sid);
  }, [loadTools]);
  const handleToolPresetChange = useCallback(async (preset: ToolPreset, customNames: string[] | null = null) => {
    // 上一次切换还没落地时连偏好都不能写：这份名单是旧的，写进去会让之后的新会话采用它。
    // 运行、手动压缩和 `!` 命令期间服务端会拒绝 set_tools，这时同样不能写偏好，
    // 否则新会话会沿用一个从没生效过的选择。
    if (toolSelectionPendingRef.current || agentRunningRef.current || bashRunningRef.current || isCompacting) return;
    if (creationSettingsLocked) {
      // 创建设置还锁着：只记下档位偏好，具体名单等解锁后由界面重放。
      setPreferredToolPreset(preset);
      return;
    }
    const toolNames = customNames ?? getToolNamesForPreset(preset);
    const sid = sessionIdRef.current;
    if (!sid) {
      // 还没有会话：这就是待创建会话要用的那一档。记进草稿状态（创建入口按它取名单），
      // 同时写偏好——那是其它新草稿的默认值，不是这一份草稿的事实来源。
      setPreferredToolPreset(preset);
      setPreferredCustomTools(customNames);
      setCustomToolNames(customNames);
      setToolSelectionKnown(true);
      setToolPresetState(preset);
      if (newSessionCwd) onPendingNewSessionEvent(newSessionCwd, { type: "SET_TOOLS", tools: { preset, custom: customNames } });
      return;
    }
    toolSelectionPendingRef.current = true;
    setToolSelectionPending(true);
    try {
      const result = await sendAgentCommand<{ sessionId?: string; recreated?: boolean }>(sid, { type: "set_tools", toolNames });
      // 服务端接受之后才写浏览器偏好：被拒绝的切换（运行、压缩、还有要移回的消息）
      // 不能变成之后新会话的默认工具。
      setPreferredToolPreset(preset);
      setPreferredCustomTools(customNames);
      if (sessionIdRef.current !== sid) return;
      // 服务端确认之后才改当前会话的档位与勾选：切换可能被拒绝（例如还有待移回的消息），
      // 那时界面必须停在原来的选择上，否则用户以为换了档，模型其实还在用旧工具。
      setCustomToolNames(customNames);
      setToolSelectionKnown(true);
      setToolPresetState(preset);
      const activeSessionId = result?.sessionId ?? sid;
      clearSlashCommands();
      if (result?.recreated || activeSessionId !== sid) {
        closeEvents();
        clearAskQuestionnaire();
        setExtensionDialog(null);
        setExtensionCustomUi(null);
        sessionIdRef.current = activeSessionId;
        await ensureEventsConnected(activeSessionId);
      }
      await loadTools(activeSessionId);
      const read = beginRuntimeRead();
      const snapshot = await fetchRuntimeState(activeSessionId, new AbortController().signal);
      if (sessionIdRef.current === activeSessionId) applyRuntimeSnapshot(read, snapshot.state);
    } catch (e) {
      console.error("Failed to set tools:", e);
      addNotice({ type: "error", message: `切换工具失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      toolSelectionPendingRef.current = false;
      setToolSelectionPending(false);
    }
  }, [creationSettingsLocked, isCompacting, setToolPresetState, clearSlashCommands, closeEvents, clearAskQuestionnaire, ensureEventsConnected, loadTools, applyRuntimeSnapshot, beginRuntimeRead, addNotice, newSessionCwd, onPendingNewSessionEvent]);

  // One lease request: it resets the session's idle countdown (renewIdleTimer()). A reply
  // that does not come within SESSION_LEASE_TIMEOUT_MS, or no network, counts as "unanswered".
  const requestLease = useCallback(async (sid: string): Promise<SessionLeaseOutcome> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_LEASE_TIMEOUT_MS);
    const lease = leaseDebugRef.current;
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let result: SessionLeaseOutcome = null;
    lease.inFlightSince = startedAt;
    lease.requests += 1;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/lease`, { method: "POST", cache: "no-store", signal: controller.signal });
      httpStatus = response.status;
      result = response.ok ? await response.json() as SessionLeaseReply : null;
      return result;
    } catch (error) {
      result = controller.signal.aborted || error instanceof TypeError ? "unanswered" : null;
      return result;
    } finally {
      clearTimeout(timeout);
      const at = Date.now();
      const outcome = result === "unanswered" ? "unanswered" : result === null ? "error" : "reply";
      if (outcome === "unanswered") lease.unanswered += 1;
      if (outcome === "error") lease.errors += 1;
      const reply = typeof result === "object" && result !== null ? result : null;
      lease.inFlightSince = null;
      lease.last = {
        at,
        durationMs: Math.max(0, at - startedAt),
        outcome,
        httpStatus,
        reply: reply && {
          running: reply.running === true,
          awaitingInput: reply.awaitingInput === true,
          subagentsActive: reply.subagentsActive === true,
        },
      };
    }
  }, []);

  // 页面续租维持选中会话存活，隐藏页也继续（后台冻结时回到前台立即补一次）。
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    const leaseDebug = leaseDebugRef.current;
    void requestLease(sid);
    const interval = setInterval(() => void requestLease(sid), SESSION_LEASE_RENEW_INTERVAL_MS);
    leaseDebug.renewStartedAt = Date.now();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void requestLease(sid);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      leaseDebug.renewStartedAt = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [requestLease, session?.id]);

  // The debug panel's view of this page's lease and run, read on its own clock. Refs only.
  // The fork's shared SSE broker owns the stream, so there is no per-page connection to report.
  const readDebugSnapshot = useCallback((): DebugClientSession => {
    const sid = sessionIdRef.current;
    const lease = leaseDebugRef.current;
    return {
      pageId: peekPageId(),
      sessionId: sid,
      selectedSessionId: session?.id ?? null,
      mounted: sessionHookMountedRef.current,
      wantsStream: sid !== null,
      connection: null,
      released: { active: false, count: 0, lastAt: null },
      reattached: { count: 0, lastAt: null, lastReason: null },
      hiddenReleaseDueAt: null,
      hiddenGraceMs: 0,
      graceDueAt: null,
      run: {
        agentRunning: agentRunningRef.current,
        bashRunning: bashRunningRef.current,
        compacting: isCompacting,
        dialogs: extensionDialogRef.current ? 1 : 0,
      },
      lease: {
        renewIntervalMs: SESSION_LEASE_RENEW_INTERVAL_MS,
        renewStartedAt: lease.renewStartedAt,
        inFlightSince: lease.inFlightSince,
        requests: lease.requests,
        unanswered: lease.unanswered,
        errors: lease.errors,
        last: lease.last && { ...lease.last, reply: lease.last.reply && { ...lease.last.reply } },
      },
    };
  }, [isCompacting, session?.id]);
  const { onDebugSnapshotReaderChange } = opts;
  useEffect(() => {
    onDebugSnapshotReaderChange?.(readDebugSnapshot);
    return () => onDebugSnapshotReaderChange?.(null);
  }, [readDebugSnapshot, onDebugSnapshotReaderChange]);

  // Load session on mount
  useEffect(() => {
    applyRuntimeState(undefined);
    contextUsageAppliedIdRef.current = contextUsageRequestIdRef.current;
    setActiveToolResults(new Map());
    if (session) {
      // 已有会话先清掉上一份工具状态：冷会话读不到名单，不能继承上一个会话的档位和差异标注。
      // 新会话不走这里，避免覆盖前面 effect 刚从浏览器偏好恢复的 customToolNames 与 toolSelectionKnown。
      setActiveToolNames(undefined);
      setPinnedToolNames(null);
      setCustomToolNames(null);
      setToolSelectionKnown(false);
      sessionIdRef.current = session.id;
      void connectEvents(session.id);
      // 先向服务端验证版本和活动 leaf，不能把旧窗口直接显示在另一个分支上。
      loadSession(session.id, true, true, { validateView: true }).then(({ agentState, runtimeRead }) => {
        restoreRuntimeFromLoad(session.id, agentState, runtimeRead);
      });
    } else if (pendingSessionView.resumingInitialization) {
      // 重新挂载后接管已有 runtime，先连接 SSE 再完成初始化，不创建第二个会话。
      void ensureNewSession().catch((error: unknown) => {
        if (isNavigationActive(navigationKey)) addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    } else if (attachSessionId) {
      // 失败态（例如绑定总超时）也走这里：只接管 SSE 与快照，不自动重跑初始化。
      sessionIdRef.current = attachSessionId;
      void connectEvents(attachSessionId);
      const controller = new AbortController();
      runtimeStateRequestRef.current = controller;
      const attachRead = beginRuntimeRead();
      void fetchRuntimeState(attachSessionId, controller.signal)
        .then((snapshot) => {
          if (sessionIdRef.current === attachSessionId) applyRuntimeSnapshot(attachRead, snapshot.state);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error("恢复待发送会话 runtime 状态失败:", error);
            if (sessionIdRef.current === attachSessionId) applyRuntimeState(undefined);
          }
        });
    }
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
        const { leafId, page, model, thinkingLevel, totalActiveMs } = viewSnapshotRef.current;
        if (!agentRunningRef.current && !bashRunningRef.current && contextVersionRef.current
          && page.sid === sid && messagesRef.current.length === entryIdsRef.current.length) {
          setSessionViewSnapshot({ sessionId: sid, revision: contextVersionRef.current,
            messages: messagesRef.current, entryIds: entryIdsRef.current, leafId,
            oldestEntryId: page.oldestEntryId, hasMore: page.hasMore, turnsBefore: page.turnsBefore,
            thinkingLevel, model, totalActiveMs, loadedEntryIds: entryIdsRef.current });
        }
        if (agentRunningRef.current || bashRunningRef.current) deleteSessionViewSnapshot(sid);
        // After the snapshot above, so the bubble of a send given back leaves it.
        releaseUnconfirmedSendRef.current();
        contextLoaderRef.current.cancel(sid);
        contextRefreshSchedulerRef.current.cancel(sid);
        shadowLifecycleRef.current.reset();
        navigationSequenceRef.current += 1;
        navigationGenerationRef.current.set(sid, navigationSequenceRef.current);
        if (!navigationChainRef.current.has(sid)) navigationGenerationRef.current.delete(sid);
      }
      backfillRequestRef.current.controller?.abort();
      backfillRequestRef.current.generation += 1;
      detailsRequestRef.current = {
        generation: detailsRequestRef.current.generation + 1,
        controller: null,
      };
      runtimeStateRequestRef.current?.abort();
      runtimeStateRequestRef.current = null;
      clearAskQuestionnaire();
      bashRecoveryIdRef.current += 1;
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemPromptLoaderChange?.(loadSystemPrompt);
    return () => onSystemPromptLoaderChange?.(null);
  }, [loadSystemPrompt, onSystemPromptLoaderChange]);

  useEffect(() => {
    const loadCurrentTools = async () => {
      const sid = sessionIdRef.current;
      return sid ? loadTools(sid) : [];
    };
    onToolsLoaderChange?.(loadCurrentTools);
    return () => onToolsLoaderChange?.(null);
  }, [loadTools, onToolsLoaderChange]);

  const branchSwitchLocked = agentRunning || bashRunning || isCompacting;
  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(details?.tree ?? [], activeLeafId, handleLeafChange, branchSwitchLocked);
  }, [details?.tree, activeLeafId, handleLeafChange, branchSwitchLocked, onBranchDataChange]);

  // Load the model list with bounded retries; loadModels exposes each failure.
  useEffect(() => {
    const controller = new AbortController();
    void retryModelLoad(loadModels, controller.signal, delay);
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;

    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id, now: Date.now(), expectedExit: exiting });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }

    // 展开的提示不计时；全部展开时没有需要等待的到期时间。
    const counting = noticeState.visible.filter((notice) => !notice.expanded);
    if (counting.length === 0) return;
    const now = Date.now();
    const nextExpiryAt = Math.min(...counting.map((notice) => (
      (notice.shownAt ?? now) + NOTICE_VISIBLE_MS
    )));
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_expired", now: Date.now() });
    }, Math.max(0, nextExpiryAt - now));
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  const messageKeys = useMemo(
    () => messageRenderKeys(entryIds, messages.length, messageKeyAliases),
    [entryIds, messages.length, messageKeyAliases],
  );

  const modelViewState = useMemo<ModelSelectionViewState>(() => {
    const modelKey = displayModel
      ? `${displayModel.provider}:${displayModel.modelId}`
      : null;
    return {
      names: modelNames,
      list: modelList,
      error: modelError,
      scopeWarnings: modelScopeWarnings,
      dataDiagnostics: modelDataDiagnostics,
      // 内部 auto 时显示 settings 的默认档位，但要按当前模型限幅：默认是 max、模型最高只到
      // high 时不能显示一个它做不到的档位。
      thinkingLevel: resolveDisplayedThinkingLevel({
        level: thinkingLevel,
        fallback: isNew ? newSessionDefaultThinkingLevel : null,
        supported: modelKey ? (modelThinkingLevels[modelKey] ?? null) : null,
      }),
      isAutoThinkingSelection: isNew && thinkingLevelOverrideRef.current === null,
      model: displayModel,
      isAutoModelSelection: isNew && newSessionModel === null,
      availableThinkingLevels: modelKey ? (modelThinkingLevels[modelKey] ?? null) : null,
      thinkingLevelMap: modelKey ? (modelThinkingLevelMaps[modelKey] ?? null) : null,
      fastEnabled,
      fastAvailable: resolveFastModeAvailability(runtimeFastAvailable, displayModelFastAvailable),
      fastPending,
      modelSwitching,
    };
  }, [
    displayModel, displayModelFastAvailable, isNew, modelDataDiagnostics, modelError, modelList, modelNames,
    fastEnabled, fastPending, modelScopeWarnings, modelSwitching, modelThinkingLevelMaps, modelThinkingLevels, newSessionModel, newSessionDefaultThinkingLevel, runtimeFastAvailable, thinkingLevel,
  ]);

  const modelViewActions = useMemo<ModelSelectionViewActions>(() => ({
    ...(session || isNew ? {
      changeModel: handleModelChange,
      changeThinkingLevel: handleThinkingLevelChange,
      changeFastEnabled: handleFastEnabledChange,
    } : {}),
  }), [handleFastEnabledChange, handleModelChange, handleThinkingLevelChange, isNew, session]);
  // 返回值整体 useMemo：流式期间 ChatWindow 每 token 重渲染时，若依赖未变则
  // 保持同一对象引用，下游 memo 组件（ChatInput/MessageView）才能跳过渲染。
  return useMemo(() => ({
    // State
    data: details, loading, error, sendError, activeLeafId, messages, entryIds, branchTailEntryIds, messageKeys, streamingStore,
    historyCursor: historyPage.sid === sessionIdRef.current ? historyPage.oldestEntryId : null,
    hasEarlierMessages: historyPage.sid === sessionIdRef.current && historyPage.hasMore,
    loadingEarlierMessages: historyPage.sid === sessionIdRef.current && historyPage.loading,
    earlierPageFailed: historyPage.sid === sessionIdRef.current && historyPage.failed,
    earlierTurnCount: historyPage.sid === sessionIdRef.current ? historyPage.turnsBefore : 0,
    missingCwd, isModelScopeActive: modelSelectionState.isScoped, allModelList, loadAllModels, agentRunning, modelState: modelViewState, modelActions: modelViewActions, toolPreset, customToolNames, activeToolNames, pinnedToolNames, toolSelectionKnown, toolSelectionPending,
    externalWriteBlocked, recalledPending, recallError, handleRetryBlockedLoad,
    retryInfo, contextUsage, systemPrompt, shadowMindEnabled, shadowMindAvailable, shadowMindTogglePending, forkingEntryId,
    isCompacting, compactError, compactResult, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, setNoticeExpanded, extensionDialog, extensionCustomUi, askQuestionnaire, submitAskQuestionnaire, cancelAskQuestionnaire, extensionStatuses, extensionWidgets, detachedSubagentStatuses: [...detachedSubagentStatuses, ...shadowReportStatuses], todos, respondToExtensionUi, sendExtensionCustomInput, armCustomAnswer,
    agentPhase, completion, runningCommands,
    isNew, creationSettingsLocked, scrollPositionRequest,
    activeToolResults, toolClocks, editEntryId,
    // Refs
    sessionIdRef, eventSourceRef,
    // Actions
    handleSend, handleAbort, startSideChat, handleFork, handleNavigate, loadEarlierMessages, retryEarlierMessages, loadUntilEntryId,
    handleCompact, handleQueuedSubmit, handleAbortCompaction, dismissCompactError,
    handleRecallQueue,
    blockedRecall,
    handleRecallBlockedQueue,
    handleBuiltinSlashCommand,
    handleShadowMindToggle, handleToolPresetChange, loadTools, refreshTools, loadSlashCommands, setActiveLeafId, setMessages,
    handleEditContent,
    cancelEdit: editEntryId ? cancelEdit : undefined,
    addNotice,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  }), [
    missingCwd,
    details, loading, error, sendError, activeLeafId, messages, entryIds, branchTailEntryIds, messageKeys, streamingStore, historyPage,
    agentRunning, allModelList, loadAllModels, modelSelectionState.isScoped, startSideChat,
    modelViewState, modelViewActions, toolPreset, customToolNames, activeToolNames, pinnedToolNames, toolSelectionKnown, toolSelectionPending,
    externalWriteBlocked, recalledPending, recallError, handleRetryBlockedLoad,
    retryInfo, contextUsage, systemPrompt, shadowMindEnabled, shadowMindAvailable, shadowMindTogglePending, forkingEntryId,
    isCompacting, compactError, compactResult, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    noticeState.visible, setNoticeExpanded, extensionDialog, extensionCustomUi, askQuestionnaire, submitAskQuestionnaire, cancelAskQuestionnaire, extensionStatuses, extensionWidgets, detachedSubagentStatuses, todos, respondToExtensionUi, sendExtensionCustomInput, armCustomAnswer,
    isNew, creationSettingsLocked, scrollPositionRequest,
    agentPhase, completion, runningCommands,
    activeToolResults, toolClocks, editEntryId, handleEditContent, cancelEdit, addNotice, shadowReportStatuses,
    sessionIdRef, eventSourceRef,
    handleSend, handleAbort, handleFork, handleNavigate, loadEarlierMessages, retryEarlierMessages, loadUntilEntryId,
    handleCompact, handleQueuedSubmit, handleAbortCompaction, dismissCompactError,
    handleRecallQueue,
    blockedRecall,
    handleRecallBlockedQueue,
    handleBuiltinSlashCommand,
    handleShadowMindToggle, handleToolPresetChange, loadTools, refreshTools, loadSlashCommands, setActiveLeafId, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    handleAgentEventRef,
  ]);
}
