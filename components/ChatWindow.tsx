"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, WorktreeInfo } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { AskDialog } from "./AskDialog";
import { AskQuestionnaire } from "./AskQuestionnaire";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { DetachedSubagentStatusPanel } from "./DetachedSubagentStatusPanel";
import { TodoListPanel } from "./TodoListPanel";
import { useAudio } from "@/hooks/useAudio";
import type { CompletionNotificationController } from "@/hooks/useCompletionNotification";
import { useCompletionEffects } from "@/hooks/useCompletionEffects";
import notificationStyles from "./CompletionNotificationPrompt.module.css";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { PendingNewSessionControl, PendingNewSessionEvent } from "@/lib/pending-new-session";
import type { ShadowSessionControl } from "./ShadowSessionToggle";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { buildMessageRenderGroups, type MessageRenderGroup } from "@/lib/message-render-groups";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionWorktrees: WorktreeInfo[];
  pendingNewSessionControl: PendingNewSessionControl;
  onPendingNewSessionEvent: (cwd: string, event: PendingNewSessionEvent) => void;
  notificationController: CompletionNotificationController;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionListRefresh?: () => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onShadowMindControlChange?: (control: ShadowSessionControl) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onNewSessionCwdChange?: (cwd: string) => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return t("chat.thinking");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function compactNotificationText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function getAssistantNotificationPreview(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks
      .filter((block): block is Extract<AssistantContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const preview = compactNotificationText(text, 80);
    if (preview) return preview;
  }
  return "";
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, renderChildren, t }: { messageCount: number; toolCallCount: number; renderChildren: () => ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {renderChildren()}
        </div>
      )}
    </div>
  );
}

export const ChatWindow = memo(function ChatWindow({ session, newSessionCwd, newSessionWorktrees, pendingNewSessionControl, onPendingNewSessionEvent, notificationController, onAgentEnd, onSessionCreated, onSessionListRefresh, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onShadowMindControlChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onNewSessionCwdChange }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const {
    notificationEnabled, notificationPermission, showNotificationPrompt,
    onNotificationToggle, dismissNotificationPrompt, notifySession,
  } = notificationController;
  const isMobile = useIsMobile();
  const materializedNewSessionId = pendingNewSessionControl.kind === "materialized"
    || pendingNewSessionControl.kind === "initialization-failed"
    ? pendingNewSessionControl.sessionId
    : null;


  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelState, modelActions, toolPreset,
    retryInfo, contextUsage, shadowMindEnabled, shadowMindAvailable, shadowMindTogglePending, forkingEntryId,
    isCompacting, compactError, compactResult, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, dismissNotice, extensionDialog, extensionCustomUi, askQuestionnaire, submitAskQuestionnaire, cancelAskQuestionnaire, extensionStatuses, extensionWidgets, detachedSubagentStatuses, todos, todoAnchorIndex, respondToExtensionUi, sendExtensionCustomInput, armCustomAnswer,
    agentPhase, completion,
    isNew, creationSettingsLocked,
    sessionIdRef, messagesEndRef, lastRenderedMessageRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork,
    handleCompact, handleQueuedSubmit, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleShadowMindToggle, handleToolPresetChange, loadSlashCommands,
  } = useAgentSession({
    session, newSessionCwd, pendingNewSessionControl, onPendingNewSessionEvent, onSessionCreated, onSessionListRefresh, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  useEffect(() => {
    const scopeKey = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : null);
    if (!scopeKey) return;
    onShadowMindControlChange?.({
      scopeKey,
      sessionId: session?.id ?? materializedNewSessionId,
      enabled: shadowMindEnabled,
      pending: shadowMindTogglePending,
      available: shadowMindAvailable,
      onToggle: handleShadowMindToggle,
    });
  }, [handleShadowMindToggle, materializedNewSessionId, newSessionCwd, onShadowMindControlChange, session, shadowMindAvailable, shadowMindEnabled, shadowMindTogglePending]);
  const notificationSessionId = sessionIdRef.current ?? session?.id ?? null;
  const notificationTitle = compactNotificationText(
    session?.name || session?.firstMessage || t("i18n.newSession"),
    48,
  );
  const notificationPreview = getAssistantNotificationPreview(messages);
  useCompletionEffects({
    completion,
    soundEnabled,
    playDoneSound,
    notifySession,
    title: notificationTitle || t("i18n.newSession"),
    body: notificationPreview || t("chat.notificationDoneBody"),
    onComplete: onAgentEnd,
  });
  const sessionBusy = agentRunning || bashRunning;

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const renderWindowKey = session?.id ?? `new:${newSessionCwd ?? "none"}`;
  const [renderWindow, setRenderWindow] = useState({ key: renderWindowKey, count: VISIBLE_PAGE_SIZE });
  // key 不匹配时当前 render 立即回落到 50，避免 effect 执行前先挂载上一会话的数百节点。
  const visibleCount = renderWindow.key === renderWindowKey ? renderWindow.count : VISIBLE_PAGE_SIZE;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setRenderWindow((current) => ({
            key: renderWindowKey,
            count: getNextVisibleCount(current.key === renderWindowKey ? current.count : VISIBLE_PAGE_SIZE),
          }));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, renderWindowKey, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addImages(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const messageRenderIndex = useMemo(() => {
    const toolResults = new Map<string, ToolResultMessage>();
    const visibleRefIndexByMessage = new Map<number, number>();
    const assistantTimestampIndices = new Set<number>();
    let visibleCount = 0;
    let lastAssistantIndex = -1;

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "toolResult") {
        toolResults.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
      }
      if (message.role === "user" || message.role === "assistant") {
        visibleRefIndexByMessage.set(index, visibleCount++);
      }
      if (message.role === "user") {
        if (lastAssistantIndex >= 0) assistantTimestampIndices.add(lastAssistantIndex);
        lastAssistantIndex = -1;
      } else if (message.role === "assistant") {
        lastAssistantIndex = index;
      }
    }
    if (lastAssistantIndex >= 0) assistantTimestampIndices.add(lastAssistantIndex);

    return { toolResults, visibleRefIndexByMessage, assistantTimestampIndices, visibleCount };
  }, [messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(messageRenderIndex.visibleCount);
  const revealHistoryForMinimap = useCallback(() => {
    setRenderWindow({ key: renderWindowKey, count: Math.max(VISIBLE_PAGE_SIZE, messages.length * 2) });
  }, [messages.length, renderWindowKey]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  // 新会话引导区：π Pi Web 正下方显示当前文件夹名
  const newSessionFolderName = (() => {
    if (!newSessionCwd) return null;
    return newSessionCwd.split(/[\\/]/).filter(Boolean).pop() ?? newSessionCwd;
  })();


  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onQueuedSubmit={agentRunning ? handleQueuedSubmit : undefined}
      isStreaming={sessionBusy}
      creationSettingsLocked={creationSettingsLocked}
      modelState={modelState}
      modelActions={modelActions}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      notificationEnabled={notificationEnabled}
      notificationPermission={notificationPermission}
      onNotificationToggle={onNotificationToggle}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      newSessionWorktrees={!session ? newSessionWorktrees : undefined}
      newSessionCwd={!session ? newSessionCwd : undefined}
      onNewSessionCwdChange={onNewSessionCwdChange}
    />
  );

  // ask 浮层卡片统一锚定在输入框上方。外层不拦截页面事件，只有卡片本身接收点击，
  // 因此问卷打开时消息区仍可滚动和查看；多题问卷只在卡片内部滚动。
  const askDialogElement = askQuestionnaire || extensionDialog?.method === "select" ? (
    <div
      className="ask-input-flyout"
      style={{ paddingRight: isMobile ? 16 : 52 }}
    >
      <div className="ask-input-flyout-content">
        {askQuestionnaire ? (
          <AskQuestionnaire
            key={askQuestionnaire.toolCallId}
            questionnaire={askQuestionnaire}
            onSubmit={submitAskQuestionnaire}
            onCancel={cancelAskQuestionnaire}
          />
        ) : extensionDialog?.method === "select" ? (
          <AskDialog
            request={extensionDialog}
            onSelect={(request, value) => respondToExtensionUi(request, { value })}
            onCustomSubmit={(request, sentinelText, text) => {
              // 先回送 sentinel 原文触发 pi 的 input 分支，同时登记待提交文本，
              // 随后的 input 请求到达时由 useAgentSession 自动应答（不弹窗）。
              const prefix = request.title.split("\n\n--- ")[0];
              armCustomAnswer(prefix, text);
              respondToExtensionUi(request, { value: sentinelText });
            }}
            onStop={handleAbort}
          />
        ) : null}
      </div>
    </div>
  ) : null;

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showNotificationPrompt && (
        <aside className={notificationStyles.prompt} role="dialog" aria-labelledby="completion-notification-title">
          <div className={notificationStyles.copy}>
            <strong id="completion-notification-title">{t("chat.notificationPromptTitle")}</strong>
            <span>{t("chat.notificationPromptBody")}</span>
          </div>
          <div className={notificationStyles.actions}>
            <button type="button" className={notificationStyles.laterButton} onClick={dismissNotificationPrompt}>
              {t("chat.notificationPromptLater")}
            </button>
            <button type="button" className={notificationStyles.enableButton} onClick={onNotificationToggle}>
              {t("chat.notificationPromptEnable")}
            </button>
          </div>
        </aside>
      )}
      {isDragOver && !sessionBusy && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}


      {extensionDialog && extensionDialog.method !== "select" && !askQuestionnaire && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, overflow: "hidden" }}>
                  <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                  <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
                </div>
                {newSessionFolderName && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden" }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span
                      title={newSessionCwd ?? undefined}
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        letterSpacing: "-0.01em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {newSessionFolderName}
                    </span>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} onDismiss={dismissNotice} />
            <div className="relative">
              {askDialogElement}
              {chatInputElement}
            </div>
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex flex-1 overflow-hidden">
        <div className="notice-shelf-overlay">
          <NoticeShelf notices={notices} onDismiss={dismissNotice} floating />
        </div>
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pt-4 [scrollbar-width:none]">
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {(() => {
              const { toolResults, visibleRefIndexByMessage, assistantTimestampIndices } = messageRenderIndex;
              // Anchor for live-tail detection and scroll positioning: the last
              // user message, or a compaction summary when compaction replaced it.
              let lastAnchorIdx = -1;
              let lastRenderedMessageIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user" || messages[i].role === "assistant") { lastRenderedMessageIdx = i; break; }
              }
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastAnchorIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = msg.role === "assistant" && assistantTimestampIndices.has(idx);
                // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp).
                if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                  showTimestamp = false;
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${idx}`}
                    message={msg}
                    toolResults={toolResults}
                    modelNames={modelState.names}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    entryId={entryIds[idx]}
                    onFork={isNew || !entryIds[idx] || bashRunning ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                  />
                );
                if (idx === lastAnchorIdx && (!isVisible || currentRefIdx === undefined)) {
                  return (
                    <div key={`${keyPrefix}-${idx}`} ref={(el) => {
                      (lastUserMsgRef as { current: HTMLDivElement | null }).current = el;
                      if (idx === lastRenderedMessageIdx) lastRenderedMessageRef.current = el;
                    }}>
                      {view}
                    </div>
                  );
                }
                if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${idx}`} ref={(el) => {
                    attachVisibleRef(idx, currentRefIdx)(el);
                    if (idx === lastRenderedMessageIdx) lastRenderedMessageRef.current = el;
                  }}>
                    {view}
                  </div>
                );
              };

              const { groups, liveTailStartIndex } = buildMessageRenderGroups(messages, {
                isAnchor: isGroupAnchor,
                findFinalAssistantIndex,
                busy: sessionBusy || streamState.isStreaming,
                lastAnchorIndex: lastAnchorIdx,
              });

              const renderGroup = (group: MessageRenderGroup): ReactNode => {
                const { start, end, finalAssistantIdx, isLiveTail } = group;
                const nodes: ReactNode[] = [];
                const appendTodoPanel = () => {
                  if (todos.length > 0 && todoAnchorIndex >= start && todoAnchorIndex < end) {
                    nodes.push(<TodoListPanel key={`todo-panel-${start}`} todos={todos} t={t} />);
                  }
                };
                if (finalAssistantIdx === -1 || isLiveTail) {
                  for (let index = start; index < end; index++) nodes.push(renderMessage(index));
                  appendTodoPanel();
                  return <Fragment key={`group-${start}`}>{nodes}</Fragment>;
                }

                nodes.push(renderMessage(start));
                const processIndices: number[] = [];
                for (let index = start + 1; index < finalAssistantIdx; index++) processIndices.push(index);
                const visibleProcessIndices = processIndices.filter((index) => hasDisplayableProcessMessage(messages[index]));
                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = finalSplit.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                  : null;
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;
                const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                if (processCount > 0) {
                  const processRefIdx = visibleProcessIndices
                    .map((index) => visibleRefIndexByMessage.get(index))
                    .find((value): value is number => typeof value === "number")
                    ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                  nodes.push(
                    <div
                      key={`process-group-${start}-${finalAssistantIdx}`}
                      ref={processRefIdx === undefined ? undefined : (element) => { messageRefs.current[processRefIdx] = element; }}
                    >
                      <ProcessDetailsGroup
                        messageCount={processCount}
                        t={t}
                        toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
                        renderChildren={() => (
                          <>
                            {visibleProcessIndices.map((index) => renderMessage(index, { attachRef: false, keyPrefix: "process" }))}
                            {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
                          </>
                        )}
                      />
                    </div>,
                  );
                }
                if (finalAnswerMessage) nodes.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
                for (let index = finalAssistantIdx + 1; index < end; index++) nodes.push(renderMessage(index));
                appendTodoPanel();
                return <Fragment key={`group-${start}`}>{nodes}</Fragment>;
              };

              const window = getVisibleRenderWindow(groups.length, visibleCount);
              // 运行中的单轮会话可能包含超过一页的工具消息。必须连同该轮锚点一起渲染，
              // 否则定位引用会被分页裁掉，恢复会话时只能滚进底部预留的空白区域。
              const startIndex = liveTailStartIndex === null
                ? window.startIndex
                : Math.min(window.startIndex, liveTailStartIndex);
              const hasMore = startIndex > 0;
              return (
                <>
                  {hasMore && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier", { count: startIndex })}
                    </div>
                  )}
                  {groups.slice(startIndex).map(renderGroup)}
                </>
              );
            })()}
            {streamState.isStreaming && streamState.streamingMessage && (
              <div ref={lastRenderedMessageRef}>
                <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelState.names} cwd={messageCwd} onOpenFile={onOpenFile} />
              </div>
            )}
            <div ref={messagesEndRef} />

            {agentRunning && !streamState.streamingMessage && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{isCompacting ? t("chat.compacting") : phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            </div>
          </div>
        </div>
        {isMobile ? null : (
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
          />
        )}
      </div>

      <div className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
            {detachedSubagentStatuses.length > 0 && (
              <DetachedSubagentStatusPanel statuses={detachedSubagentStatuses} t={t} />
            )}
          </div>
        </div>
        <div className="relative">
          {askDialogElement}
          {chatInputElement}
        </div>
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
      </>
      )}
    </div>
  );
});
function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, onDismiss, floating = false }: { notices: NoticeItem[]; onDismiss: (id: string) => void; floating?: boolean }) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div className="notice-shelf" style={{ marginBottom: floating ? 0 : 10 }}>
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <button
            key={notice.id}
            type="button"
            onClick={() => onDismiss(notice.id)}
            aria-label={`${notice.message}，${t("i18n.close")}`}
            className="notice-shelf-item"
            style={{
              marginBottom: index === notices.length - 1 ? 0 : 6,
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
            }}
          >
            <span className="notice-shelf-dot" style={{ background: color }} />
            <span className="notice-shelf-message">{notice.message}</span>
          </button>
        );
      })}
    </div>
  );
}


type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
