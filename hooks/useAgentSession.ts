"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import type { AgentRuntimeSnapshot, AgentRuntimeState, AgentSubmitAcknowledgement } from "@/lib/agent-state";
import type { SelectedModel } from "@/lib/model-types";
import type { ModelSelectionViewActions, ModelSelectionViewState } from "@/lib/model-selection-types";
import { resolveFastModeAvailability } from "@/lib/fast-mode";
import { isThinkingLevel, type ThinkingLevelOption } from "@/lib/thinking-levels";
import { recordThinkingLevelPreference } from "@/lib/thinking-level-preference-client";
import { materializeNewSession, releaseNewSessionMaterialization, type NewSessionMaterializationResult } from "@/lib/new-session-materialization-client";
import { selectPendingNewSession, type PendingNewSessionControl, type PendingNewSessionEvent } from "@/lib/pending-new-session";
import { useModelSelection } from "@/hooks/useModelSelection";
import { useFrameBatchedStreamDispatch } from "@/hooks/useFrameBatchedStreamDispatch";
import { useRunCompletion } from "@/hooks/useRunCompletion";
export type { ThinkingLevelOption } from "@/lib/thinking-levels";
import { normalizeAssistantMessage } from "@/lib/normalize";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import type { ToolPreset } from "@/lib/tool-presets";
import { sendAgentCommand } from "@/lib/agent-client";
import { setDraft, type ChatDraft } from "@/lib/draft-store";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import {
  fetchRuntimeState,
  fetchSessionContext,
  fetchSessionDetails,
  type SessionContextSnapshot,
  type SessionDetails,
  invalidateSessionContext,
} from "@/lib/session-load-client";
import { LatestContextLoader } from "@/lib/latest-context-loader";
import { SessionContextRefreshScheduler } from "@/lib/session-context-refresh-scheduler";
import { ShadowLifecycleCoordinator } from "@/lib/shadow-lifecycle";
import { useShadowSessionSetting } from "@/hooks/useShadowSessionSetting";
import type { ChatScrollPosition, ChatScrollPositionRequest } from "@/lib/chat-scroll-position";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  type ClientAssistantMessageEvent,
} from "@/lib/streaming-message";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import type { SessionListRefreshRequest } from "@/lib/session-list-refresh-coordinator";
type DetachedSubagentMode = "auto-resume" | "next-turn";
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

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

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

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  // 排队中的提示不计时，从真正进入可见队列时开始停留 5 秒。
  shownAt?: number;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem; now: number }
  | { type: "mark_expired"; now: number }
  | { type: "remove"; id: string; now: number };

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
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  pendingNewSessionControl: PendingNewSessionControl;
  onPendingNewSessionEvent: (cwd: string, event: PendingNewSessionEvent) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  // 新会话首次落盘或一轮运行结束后刷新侧栏列表。
  onSessionListRefresh?: (request: SessionListRefreshRequest) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** 注册一个非 prompt 的启动动作，供系统面板按需读取系统提示词。 */
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onToolsLoaderChange?: (loader: (() => Promise<ToolEntry[]>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

// 父轮结束后，扩展可能异步注入一轮新的 agent run（例如后台子代理完成）。
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
// AgentSession 冷启动可能包含模型、扩展和资源初始化，5 秒不足以覆盖正常启动耗时。
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 15_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5_000;
const NOTICE_EXIT_ANIMATION_MS = 180;

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
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

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[], now: number): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, { ...next, shownAt: now }];
    nextPending = rest;
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.length >= MAX_NOTICES) {
        return { ...state, pending: [...state.pending, action.notice] };
      }
      return {
        ...state,
        visible: [...state.visible, { ...action.notice, shownAt: action.now }],
      };
    }
    case "mark_expired":
      return {
        ...state,
        visible: state.visible.map((notice) => (
          !notice.exiting && notice.shownAt !== undefined
            && action.now - notice.shownAt >= NOTICE_VISIBLE_MS
            ? { ...notice, exiting: true }
            : notice
        )),
      };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending, action.now);
    }
    default:
      return state;
  }
}

function parseAskQuestionnaire(input: unknown): AskQuestionnaireQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length < 2) return null;

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

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  clearAcceptedPrompt: () => void;
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
    session, newSessionCwd, pendingNewSessionControl, onPendingNewSessionEvent, onSessionCreated, onSessionListRefresh, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onToolsLoaderChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const pendingControlKind = pendingNewSessionControl.kind;
  const pendingSessionView = selectPendingNewSession(pendingNewSessionControl);
  const pendingShadowMindEnabled = pendingSessionView.desiredShadowMindEnabled;
  const creationSettingsLocked = pendingSessionView.busy;
  const materializedNewSessionId = pendingSessionView.transportSessionId;
  const { completion, beginRun, settleRun } = useRunCompletion();

  const [contextModel, setContextModel] = useState<SessionContextSnapshot["model"]>(null);
  const [detailsState, setDetailsState] = useState<{ sid: string; value: SessionDetails } | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  const dispatchStreamBatch = useCallback((events: ClientAssistantMessageEvent[]) => {
    dispatch({ type: "delta_batch", events });
  }, []);
  const streamScopeKey = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : null);
  const {
    enqueue: enqueueStreamDelta,
    flush: flushStreamDeltas,
    reset: resetStreamDeltas,
  } = useFrameBatchedStreamDispatch(dispatchStreamBatch, streamScopeKey);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const { modelState: modelSelectionState, modelActions: modelSelectionActions } = useModelSelection();
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
  } = modelSelectionState;
  const [fastEnabled, setFastEnabled] = useState(false);
  const [runtimeFastAvailable, setRuntimeFastAvailable] = useState<boolean | null>(null);
  const [fastPending, setFastPending] = useState(false);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
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
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const detachedSubagentStatuses = useMemo(() => deriveDetachedSubagentStatuses(messages), [messages]);
  const shadowReportStatuses = useMemo(() => deriveShadowReportStatus(messages), [messages]);
  const todos = useMemo(() => deriveTodos(messages), [messages]);


  const eventSourceRef = useRef<EventSource | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  // detached 子代理可能跨越多个父轮，必须按 agentId 保持到对应 completion 到达。
  const pendingDetachedSubagentIdsRef = useRef(new Set<string>());
  const sessionIdRef = useRef<string | null>(session?.id ?? materializedNewSessionId);
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
  const details = session && detailsState?.sid === session.id ? detailsState.value : null;
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const [scrollPositionRequest, setScrollPositionRequest] = useState<ChatScrollPositionRequest | null>(null);
  const requestScrollPosition = useCallback((position: ChatScrollPosition) => {
    setScrollPositionRequest((current) => ({
      generation: (current?.generation ?? 0) + 1,
      position,
    }));
  }, []);
  const newSessionPromotedRef = useRef(false);
  const initialPendingSettings = pendingNewSessionControl.kind === "staged" ? pendingNewSessionControl : null;
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(initialPendingSettings?.model ?? null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(
    initialPendingSettings?.thinkingLevel === "auto" ? null : initialPendingSettings?.thinkingLevel ?? null,
  );
  const recommendedThinkingLevelRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  useEffect(() => {
    if (!isNew || !initialPendingSettings) return;
    if (initialPendingSettings.model) {
      void modelSelectionActions.selectNewSessionModel(initialPendingSettings.model, false);
      setPendingModel(initialPendingSettings.model);
    }
    modelSelectionActions.setThinkingLevel(initialPendingSettings.thinkingLevel);
  // 仅在该 cwd 的新会话组件挂载时恢复一次，后续变更由交互处理器同步。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
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
    runSlashCommand: runShadowSlashCommand,
    toggle: handleShadowMindToggle,
  } = shadowSessionSetting;

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  useEffect(() => {
    if (!isNew || sessionIdRef.current) return;
    setToolPresetState(getPreferredToolPreset());
  }, [isNew, setToolPresetState]);

  const currentModel = currentModelOverride ?? contextModel ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;
  const displayModelFastAvailable = displayModel
    ? modelList.find((model) => model.provider === displayModel.provider && model.id === displayModel.modelId)?.fastAvailable ?? false
    : false;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
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
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, details?.filePath, session?.id, session?.name]);


  /** 所有服务端运行状态都通过这一入口投影，避免挂载、reload、reconcile 字段漂移。 */
  const applyRuntimeState = useCallback((state: AgentRuntimeState | undefined) => {
    setIsCompacting(state?.isCompacting ?? false);
    setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
    if (!state) {
      setFastEnabled(false);
      setRuntimeFastAvailable(null);
      return;
    }
    setContextUsage(state.contextUsage);
    setSystemPrompt(state.systemPrompt);
    applyShadowRuntimeState(state);
    modelSelectionActions.setThinkingLevel(state.thinkingLevel);
    setFastEnabled(state.fastEnabled);
    setRuntimeFastAvailable(state.fastAvailable);
    setExtensionStatuses(state.extensionStatuses);
    setExtensionWidgets(filterVisibleExtensionWidgets(state.extensionWidgets));
  }, [applyShadowRuntimeState, modelSelectionActions]);

  /** context 的所有派生状态统一原子提交，挂载加载和分支导航不得各维护一份字段列表。 */
  const commitContextSnapshot = useCallback((
    sid: string,
    snapshot: SessionContextSnapshot,
    leafId: string | null,
    options: { preserveScroll?: boolean } = {},
  ): boolean => {
    if (sessionIdRef.current !== sid) return false;
    setContextModel(snapshot.model);
    setActiveLeafId(leafId);
    pendingDetachedSubagentIdsRef.current = pendingDetachedSubagentIds(snapshot.messages);
    if (!options.preserveScroll) {
      // 首屏、导航和 backfill 属于显式定位；后台 entry 刷新必须保持用户滚动位置。
      requestScrollPosition("initial");
    }
    setMessages(snapshot.messages);
    setEntryIds(snapshot.entryIds);
    setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
    setError(null);
    if (snapshot.thinkingLevel && snapshot.thinkingLevel !== "off") {
      modelSelectionActions.setThinkingLevel(snapshot.thinkingLevel);
    }
    setLoading(false);
    return true;
  }, [modelSelectionActions, requestScrollPosition]);
  const startContextBackfill = useCallback((sid: string, generation: number) => {
    const controller = new AbortController();
    backfillRequestRef.current.controller = controller;
    void fetchSessionContext(sid, controller.signal, { skipCache: true }).then((loaded) => {
      const current = backfillRequestRef.current;
      if (loaded.kind === "loaded" && current.sid === sid && current.generation === generation && sessionIdRef.current === sid) {
        commitContextSnapshot(sid, loaded.snapshot, loaded.leafId);
      }
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Failed to backfill session context:", error);
    }).finally(() => {
      if (backfillRequestRef.current.generation === generation) backfillRequestRef.current.controller = null;
    });
  }, [commitContextSnapshot]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    backfillRequestRef.current.controller?.abort();
    const backfillGeneration = backfillRequestRef.current.generation + 1;
    backfillRequestRef.current = { sid, generation: backfillGeneration, controller: null };
    const earlyRuntimeController = includeState ? new AbortController() : null;
    const earlyRuntimePromise = earlyRuntimeController
      ? fetchRuntimeState(sid, earlyRuntimeController.signal).then((snapshot) => {
          if (sessionIdRef.current === sid) applyRuntimeState(snapshot.state);
          return snapshot;
        }).catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error("Failed to load early session runtime state:", error);
            if (sessionIdRef.current === sid) applyRuntimeState(undefined);
          }
          return null;
        })
      : null;
    if (showLoading) setLoading(true);
    try {
      const contextResult = await contextLoaderRef.current.run(
        sid,
        (signal) => fetchSessionContext(sid, signal),
        (loaded) => {
          if (sessionIdRef.current !== sid) return false;
          if (loaded.kind === "missing") {
            if (showLoading) {
              setContextModel(null);
              setDetailsState(null);
              setActiveLeafId(null);
              setMessages([]);
              setEntryIds([]);
              setError(null);
            }
            setLoading(false);
            return false;
          }
          return commitContextSnapshot(sid, loaded.snapshot, loaded.leafId);
      });
      if (!contextResult.committed || !contextResult.value) return { loaded: false, agentState: null };

      // 首屏先显示预加载消息，再后台补齐完整历史。
      startContextBackfill(sid, backfillGeneration);
      detailsRequestRef.current.controller?.abort();
      const controller = new AbortController();
      const generation = detailsRequestRef.current.generation + 1;
      detailsRequestRef.current = { generation, controller };
      void fetchSessionDetails(sid, controller.signal)
        .then((sessionDetails) => {
          if (
            detailsRequestRef.current.generation === generation
            && sessionIdRef.current === sid
          ) setDetailsState({ sid, value: sessionDetails });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to load session details:", error);
        });

      if (!includeState) return { loaded: true, agentState: null };
      runtimeStateRequestRef.current?.abort();
      const runtimeController = earlyRuntimeController ?? new AbortController();
      runtimeStateRequestRef.current = runtimeController;
      try {
        const agentState = earlyRuntimePromise ? await earlyRuntimePromise : await fetchRuntimeState(sid, runtimeController.signal);
        if (!agentState) return { loaded: true, agentState: null };
        if (sessionIdRef.current !== sid || runtimeStateRequestRef.current !== runtimeController) {
          return { loaded: true, agentState: null };
        }
        applyRuntimeState(agentState.state);
        return { loaded: true, agentState };
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to load session runtime state:", error);
          if (sessionIdRef.current === sid) applyRuntimeState(undefined);
        }
        return { loaded: true, agentState: null };
      } finally {
        if (runtimeStateRequestRef.current === runtimeController) runtimeStateRequestRef.current = null;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { loaded: false, agentState: null };
      }
      if (sessionIdRef.current === sid) {
        setError(String(error));
        setLoading(false);
      }
      return { loaded: false, agentState: null };
    }
  }, [applyRuntimeState, commitContextSnapshot, startContextBackfill]);

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

  const loadCompactedSession = useCallback(async (sid: string, showLoading = false) => {
    return loadSession(sid, showLoading);
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

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
        return tools;
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
    return [];
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    // 父级升级会改变 draftKey；先同步清空，避免旧输入在 key 切换副作用中回写临时草稿。
    opts.chatInputRef?.current?.clearAcceptedPrompt();
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [isNew, newSessionCwd, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (pendingControlKind === "initialization-failed") {
      throw new Error(pendingNewSessionControl.error);
    }
    if (pendingControlKind === "materialized") {
      sessionIdRef.current = pendingNewSessionControl.sessionId;
      return pendingNewSessionControl.sessionId;
    }

    const recoverySessionId = pendingControlKind === "materialization-failed"
      || pendingControlKind === "recovering"
      ? pendingNewSessionControl.sessionId
      : null;
    const requestedShadowMindEnabled = pendingNewSessionControl.shadowMindEnabled;
    if (pendingControlKind === "materialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, { type: "RETRY" });
    } else if (pendingControlKind === "staged") {
      onPendingNewSessionEvent(newSessionCwd, { type: "START" });
    }

    const selectedModel = newSessionModelOverrideRef.current;
    const selectedThinkingLevel = thinkingLevelOverrideRef.current ?? recommendedThinkingLevelRef.current;
    if (selectedModel) setPendingModel(selectedModel);

    let result: NewSessionMaterializationResult;
    try {
      result = await materializeNewSession({
        ...(recoverySessionId
          ? { operation: "finalize-existing" as const, sessionId: recoverySessionId }
          : { operation: "create" as const }),
        cwd: newSessionCwd,
        toolNames: getToolNamesForPreset(toolPreset),
        shadowMindEnabled: requestedShadowMindEnabled,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
        ...(fastEnabled && displayModelFastAvailable ? { fastEnabled: true } : {}),
      });
    } catch (error) {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "REQUEST_FAIL",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const realId = result.sessionId;
    sessionIdRef.current = realId;
    if (result.kind === "materialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "POST_START_FAIL",
        sessionId: realId,
        error: result.error,
      });
      throw new Error(result.error);
    }

    applyShadowRuntimeState(result);
    if (result.kind === "initialization-failed") {
      onPendingNewSessionEvent(newSessionCwd, {
        type: "INIT_FAIL",
        sessionId: realId,
        error: result.error,
      });
    } else {
      onPendingNewSessionEvent(newSessionCwd, { type: "READY", sessionId: realId });
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
  }, [applyShadowRuntimeState, displayModelFastAvailable, fastEnabled, isNew, loadTools, newSessionCwd, onPendingNewSessionEvent, pendingControlKind, pendingNewSessionControl, toolPreset]);

  // 系统面板可在首条消息发送前读取提示词；这里只初始化运行时并查询状态，
  // 不触发 prompt，也不会向会话历史追加消息。
  const loadSystemPrompt = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;
    const state = await sendAgentCommand<AgentRuntimeState>(sid, { type: "get_state" });
    if (sessionIdRef.current !== sid) return;
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession]);

  const loadSlashCommands = useCallback(async () => {
    const sid = await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions.
          settle("closed");
          if (eventSourceRef.current === es && agentRunningRef.current) {
            eventSourceRef.current = null;
            setTimeout(() => {
              if (agentRunningRef.current) void connectEvents(sid);
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents]);

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

  const dismissNotice = useCallback((id: string) => {
    dispatchNotice({ type: "remove", id, now: Date.now() });
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
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
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
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef, queueAskQuestionnaireRequest, respondToExtensionUi]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const scheduleEventStreamClose = useCallback((sid: string) => {
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
  }, [cancelEventStreamGrace, closeEvents]);

  /** 本地发送、外部 agent_start 与挂载恢复统一从这里采用主运行。 */
  const enterMainRun = useCallback((phase: AgentPhase): number => {
    if (!agentRunningRef.current) {
      resetStreamDeltas();
      const runId = promptRunIdRef.current + 1;
      promptRunIdRef.current = runId;
      beginRun(runId);
      agentRunningRef.current = true;
    }
    setAgentRunning(true);
    setAgentPhase(phase);
    dispatch({ type: "start" });
    return promptRunIdRef.current;
  }, [beginRun, resetStreamDeltas]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // completion 控制器负责当前轮校验与重复 settled 拒绝。
    if (!settleRun(runId, sid)) return;

    // 服务端确认 idle 后立即发布完成事件；消息重载不能阻塞声音和系统通知。
    agentRunningRef.current = false;
    if (sid) scheduleEventStreamClose(sid);
    optimisticUserMessageKeyRef.current = null;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    flushStreamDeltas();
    dispatch({ type: "end" });
    if (sid) {
      // AppShell coordinator 合并新会话的 settled 与标题刷新。
      onSessionListRefresh?.({ reason: "run-settled", sessionId: sid });
      // 完成副作用已发布，最终消息同步作为独立刷新执行。
      void loadSession(sid);
    }
  }, [flushStreamDeltas, loadSession, onSessionListRefresh, scheduleEventStreamClose, settleRun]);

  const readAgentSnapshot = useCallback(async (sid: string): Promise<AgentRuntimeSnapshot | null> => {
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
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
  ) => {
    if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return;
    applyRuntimeState(snapshot.state);

    if (snapshot.busy) {
      agentRunningRef.current = true;
      setAgentRunning(true);
      return;
    }
    // 扩展 UI 等待用户输入时 wrapper 可能暂时 idle，不能提前结束交互。
    if (extensionDialogRef.current || askQuestionnaireRef.current || !agentRunningRef.current) return;
    await finishPromptWithoutStream(sid, runId);
  }, [applyRuntimeState, finishPromptWithoutStream]);

  const reconcileAgentState = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const generation = reconcileRequestGenerationRef.current + 1;
    reconcileRequestGenerationRef.current = generation;
    const snapshot = await readAgentSnapshot(sid);
    // 同一 run 的多个触发可能乱序返回，只允许最新请求提交状态。
    if (generation !== reconcileRequestGenerationRef.current || !snapshot) return;
    await applyAgentSnapshot(sid, runId, snapshot);
  }, [applyAgentSnapshot, readAgentSnapshot]);
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
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
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

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        cancelEventStreamGrace();
        // 新一轮运行开始：重置流式消息计数（message_end 的 updater 会重新累计）。
        lastStreamedMessageCountRef.current = 0;
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
          // SSE 可能丢失最后一段 message_end，刷新页面才会暴露这个问题。
          invalidateSessionContext(sessionIdRef.current);
          void loadSession(sessionIdRef.current);
          void reconcileAgentState(sessionIdRef.current, promptRunIdRef.current);
        }
        break;
      case "agent_settled":
      case "prompt_done":
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
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
        // Reconnects may receive the in-flight assistant snapshot before the
        // next delta. The reducer owns the canonical streaming message shape.
        if (!agentRunningRef.current) break;
        resetStreamDeltas();
        if (event.message) dispatch({ type: "snapshot", message: event.message as AgentMessage });
        setAgentPhase(null);
        break;
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as AgentMessage | undefined;
        if (msg?.role === "user") break;
        const assistantMessageEvent = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
        if (assistantMessageEvent) {
          enqueueStreamDelta(assistantMessageEvent);
        } else if (msg) {
          // Compatibility with older servers that sent a cumulative partial.
          resetStreamDeltas();
          dispatch({ type: "snapshot", message: normalizeAssistantMessage(msg) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
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
        if (completed && completed.role === "user") {
          // SDK 为了展开 inline skill 会把命令整理到前缀；展示层保留发送前的原始输入。
          // 仅替换仍紧邻末尾的乐观消息，队列消息在首轮 message_end 后会正常追加。
          const delivered = normalizeAssistantMessage(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
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
          setMessages((prev) => {
            const next = [...prev, normalizeAssistantMessage(completed)];
            lastStreamedMessageCountRef.current = next.length;
            return next;
          });
        }
        dispatch({ type: "end" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        if (name === "ask_user_question") {
          const questions = parseAskQuestionnaire(event.args);
          if (questions) {
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
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        if (askQuestionnaireRef.current?.toolCallId === id) clearAskQuestionnaire();
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const progress = getToolExecutionProgress(event.partialResult);
        if (!id || !progress) break;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          return {
            kind: "running_tools",
            tools: prev.tools.map((tool) => tool.id === id ? { ...tool, progress } : tool),
          };
        });
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_continue":
        addNotice({ type: "info", message: "检测到上轮工具调用未执行完成，已自动继续" });
        break;
      case "auto_continue_stopped":
        addNotice({ type: "warning", message: "自动继续已停止：工具调用反复无法完成，请检查环境或手动处理" });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadCompactedSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed": {
        const id = event.id as string;
        setExtensionDialog((current) => current?.id === id ? null : current);
        if (extensionDialogRef.current?.id === id) extensionDialogRef.current = null;
        if (askQuestionnaireRequestIdsRef.current.has(id)) clearAskQuestionnaire();
        break;
      }
    }
  }, [addNotice, cancelEventStreamGrace, clearAskQuestionnaire, consumeShadowEntry, enqueueStreamDelta, enterMainRun, flushStreamDeltas, handleExtensionUiRequest, isNew, loadCompactedSession, loadSession, onSessionListRefresh, reconcileAgentState, resetStreamDeltas, scheduleContextRefresh, scheduleEventStreamClose]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    backfillRequestRef.current.controller?.abort();
    backfillRequestRef.current.generation += 1;
    const requestSessionId = sessionIdRef.current ?? session?.id ?? null;
    if (requestSessionId) invalidateSessionContext(requestSessionId);
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    // UI 状态可能晚于异步扩展启动的 agent_start；此时不可吞掉用户输入。
    if (agentRunningRef.current || bashRunningRef.current) return false;
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
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return true;
    }

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    const promptRunId = enterMainRun(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    requestScrollPosition("user");

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const alreadyMaterialized = pendingControlKind === "materialized";
        const sid = await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (alreadyMaterialized) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          try {
            const runtimeState = await sendAgentCommand<AgentRuntimeState>(sid, { type: "get_state" });
            if (runtimeState.model && isThinkingLevel(runtimeState.thinkingLevel)) {
              void recordThinkingLevelPreference(runtimeState.model.id, runtimeState.thinkingLevel);
            }
          } catch (preferenceError) {
            console.error("[pi-web] 获取思考强度实际值失败:", preferenceError);
          }
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void reconcileAgentState(sentSessionId, promptRunId);
      }
      return Boolean(sentSessionId);
    } catch (e) {
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      if (promptRequestStarted && sentSessionId) {
        void reconcileAgentState(sentSessionId, promptRunId);
        // 请求已发出但响应失败时，服务端可能已受理；保留原有的乐观提交行为。
        return true;
      }
      agentRunningRef.current = false;
      closeEvents();
      if (e instanceof EventStreamConnectionError) {
        const optimisticKey = optimisticUserMessageKeyRef.current;
        if (optimisticKey) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: e.message });
      }
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      resetStreamDeltas();
      dispatch({ type: "end" });
      return false;
    }
  }, [addNotice, closeEvents, ensureEventsConnected, ensureNewSession, enterMainRun, isNew, newSessionCwd, newSessionModel, pendingControlKind, promoteNewSession, reconcileAgentState, requestScrollPosition, resetStreamDeltas, session]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    // 中止会话后不再等待用户输入，关闭挂起的 dialog 弹窗
    setExtensionDialog(null);
    extensionDialogRef.current = null;
    clearAskQuestionnaire();
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, [clearAskQuestionnaire]);

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
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const navigateToLeaf = useCallback((sid: string, leafId: string | null): Promise<void> => {
    const generation = navigationSequenceRef.current + 1;
    navigationSequenceRef.current = generation;
    navigationGenerationRef.current.set(sid, generation);
    const previous = navigationChainRef.current.get(sid) ?? Promise.resolve();
    const baseOperation = previous.then(async () => {
      if (navigationGenerationRef.current.get(sid) !== generation || sessionIdRef.current !== sid) return;
      if (leafId) await sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId });
      if (navigationGenerationRef.current.get(sid) !== generation || sessionIdRef.current !== sid) return;
      await loadContext(sid, leafId);
    }).catch((error) => {
      if (navigationGenerationRef.current.get(sid) === generation) console.error("Failed to navigate session:", error);
    });
    const operation = baseOperation.finally(() => {
      if (navigationChainRef.current.get(sid) !== operation) return;
      navigationChainRef.current.delete(sid);
      navigationGenerationRef.current.delete(sid);
    });
    navigationChainRef.current.set(sid, operation);
    return operation;
  }, [loadContext]);
  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    await navigateToLeaf(sid, leafId);
  }, [navigateToLeaf]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      if (creationSettingsLocked) return;
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      if (newSessionCwd) onPendingNewSessionEvent(newSessionCwd, { type: "SET_MODEL", model: selectedModel });
      const selection = await modelSelectionActions.selectNewSessionModel(
        selectedModel,
        thinkingLevelOverrideRef.current === null,
      );
      if (!selection.committed || newSessionModelOverrideRef.current !== selectedModel) return;
      if (thinkingLevelOverrideRef.current === null) {
        recommendedThinkingLevelRef.current = selection.preferredThinking ?? null;
      }
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
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
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to switch model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, creationSettingsLocked, currentModelOverride, isNew, loadSession, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadCompactedSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadCompactedSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const preferredThinking = await modelSelectionActions.load({
      cwd: newSessionCwd ?? session?.cwd ?? "",
      initializeNewSession: isNew && !sessionIdRef.current,
      applyPinnedThinking: thinkingLevelOverrideRef.current === null,
      signal,
    });
    if (isNew && !sessionIdRef.current) {
      if (thinkingLevelOverrideRef.current === null) {
        recommendedThinkingLevelRef.current = preferredThinking ?? null;
      }
    }
  }, [isNew, modelSelectionActions, newSessionCwd, session?.cwd]);


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
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadCompactedSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
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
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "shadow": {
          const shadowResult = await runShadowSlashCommand(text, sid);
          if (!shadowResult.handled) return { handled: false };
          if (!shadowResult.success) return complete({ handled: true, error: shadowResult.error });
          return complete({ handled: true, message: shadowResult.message });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, loadCompactedSession, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, runShadowSlashCommand]);

  // 运行中提交统一走确认式契约：只有服务端确认 Pi 已接受后才允许输入框清空。
  // 斜杠命令需要保留 prompt 的模板展开语义，普通文本则使用原生 steer/followUp 队列。
  const handleQueuedSubmit = useCallback(async (
    message: string,
    mode: "steer" | "followUp",
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) {
      addNotice({ type: "error", message: "当前会话尚未就绪，消息未发送" });
      return false;
    }
    const shadowResult = await runShadowSlashCommand(message, sid);
    if (shadowResult.handled) {
      if (!shadowResult.success) addNotice({ type: "error", message: shadowResult.error });
      return shadowResult.success;
    }
    const command = message.startsWith("/")
      ? { type: "prompt", message, streamingBehavior: mode }
      : { type: mode === "steer" ? "steer" : "follow_up", message };
    try {
      const acknowledgement = await sendAgentCommand<AgentSubmitAcknowledgement>(sid, command);
      if (!acknowledgement?.accepted) throw new Error("服务端未确认接收消息");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      addNotice({ type: "error", message: `消息发送失败，输入已保留：${detail}` });
      return false;
    }
  }, [addNotice, runShadowSlashCommand]);

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
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (creationSettingsLocked) return;
    modelSelectionActions.setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
      if (newSessionCwd) onPendingNewSessionEvent(newSessionCwd, { type: "SET_THINKING_LEVEL", level });
      recommendedThinkingLevelRef.current = null;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [creationSettingsLocked, isNew, modelSelectionActions, newSessionCwd, onPendingNewSessionEvent]);


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
  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    setPreferredToolPreset(preset);
    if (creationSettingsLocked) return;
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [creationSettingsLocked, setToolPresetState]);

  // Load session on mount
  useEffect(() => {
    applyRuntimeState(undefined);
    if (session) {
      sessionIdRef.current = session.id;
      void connectEvents(session.id);
      loadSession(session.id, true, true).then(({ agentState }) => {
        if (agentState?.alive) {
          loadTools(session.id);
          const runtimeState = agentState.state;
          if (agentState.busy && runtimeState && !runtimeState.isBashRunning) {
            requestScrollPosition("running-end");
            enterMainRun(runtimeState.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            void connectEvents(session.id);
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (!agentRunningRef.current && pendingDetachedSubagentIdsRef.current.size > 0) {
          // 刷新后只恢复后台监听，不能把 detached 子代理显示成主代理思考。
          void connectEvents(session.id);
        }
      });
    } else if (materializedNewSessionId) {
      sessionIdRef.current = materializedNewSessionId;
      void connectEvents(materializedNewSessionId);
      const controller = new AbortController();
      runtimeStateRequestRef.current = controller;
      void fetchRuntimeState(materializedNewSessionId, controller.signal)
        .then((snapshot) => {
          if (sessionIdRef.current === materializedNewSessionId) applyRuntimeState(snapshot.state);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error("恢复待发送会话 runtime 状态失败:", error);
            if (sessionIdRef.current === materializedNewSessionId) applyRuntimeState(undefined);
          }
        });
    }
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
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

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(details?.tree ?? [], activeLeafId, handleLeafChange);
  }, [details?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
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
        dispatchNotice({ type: "remove", id: exiting.id, now: Date.now() });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }

    const now = Date.now();
    const nextExpiryAt = Math.min(...noticeState.visible.map((notice) => (
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
      thinkingLevel,
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
    fastEnabled, fastPending, modelScopeWarnings, modelSwitching, modelThinkingLevelMaps, modelThinkingLevels, newSessionModel, runtimeFastAvailable, thinkingLevel,
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
    data: details, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelState: modelViewState, modelActions: modelViewActions, toolPreset,
    retryInfo, contextUsage, systemPrompt, shadowMindEnabled, shadowMindAvailable, shadowMindTogglePending, forkingEntryId,
    isCompacting, compactError, compactResult, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, dismissNotice, extensionDialog, extensionCustomUi, askQuestionnaire, submitAskQuestionnaire, cancelAskQuestionnaire, extensionStatuses, extensionWidgets, detachedSubagentStatuses: [...detachedSubagentStatuses, ...shadowReportStatuses], todos, respondToExtensionUi, sendExtensionCustomInput, armCustomAnswer,
    agentPhase, completion,
    isNew, creationSettingsLocked, scrollPositionRequest,
    // Refs
    sessionIdRef, eventSourceRef,
    // Actions
    handleSend, handleAbort, handleFork,
    handleCompact, handleQueuedSubmit, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleShadowMindToggle, handleToolPresetChange, loadTools, loadSlashCommands, setActiveLeafId, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  }), [
    details, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelViewState, modelViewActions, toolPreset,
    retryInfo, contextUsage, systemPrompt, shadowMindEnabled, shadowMindAvailable, shadowMindTogglePending, forkingEntryId,
    isCompacting, compactError, compactResult, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    noticeState.visible, dismissNotice, extensionDialog, extensionCustomUi, askQuestionnaire, submitAskQuestionnaire, cancelAskQuestionnaire, extensionStatuses, extensionWidgets, detachedSubagentStatuses, todos, respondToExtensionUi, sendExtensionCustomInput, armCustomAnswer,
    isNew, creationSettingsLocked, scrollPositionRequest,
    agentPhase, completion,
    sessionIdRef, eventSourceRef,
    handleSend, handleAbort, handleFork,
    handleCompact, handleQueuedSubmit, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleShadowMindToggle, handleToolPresetChange, loadTools, loadSlashCommands, setActiveLeafId, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    handleAgentEventRef,
  ]);
}
