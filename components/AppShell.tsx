"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import type { ChatReadingPosition } from "@/lib/chat-scroll-position";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { movePanelTab, orderPanelTabs } from "@/lib/panel-tab-order";
import { openFileTab, saveFileViewerState, saveParkedFileViewerState, switchFileWorkspace, type ParkedFileWorkspace } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { AppTopBar } from "./AppTopBar";
import { TerminalPanel } from "./TerminalPanel";
import { SubagentViewer } from "./SubagentViewer";
import { SessionChatPanel } from "./SessionChatPanel";
import { createSideChat, deleteSideChat } from "@/lib/side-chat-client";
import { DevServerViewer } from "./DevServerViewer";
import { agentOverlayTabId, serverOverlayTabId, type OverlayTab } from "./overlay-tabs";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { appendSideTab, restoreSideTabs, sideTabsKey } from "./side-tab-state";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useFilePanel } from "@/hooks/useFilePanel";
import { useTopPanel, type TopPanel } from "@/hooks/useTopPanel";
import { useSessionNavigation } from "@/hooks/useSessionNavigation";
import { useProjectTrust } from "@/hooks/useProjectTrust";
import { useSessionPresentation } from "@/hooks/useSessionPresentation";
import { useSessionAutoName } from "@/hooks/useSessionAutoName";
import { useWorktreeState } from "@/hooks/useWorktreeState";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";
import { useRunningSessions } from "@/hooks/useRunningSessions";
import { useRunningSessionTransitions } from "@/hooks/useRunningSessionTransitions";
import { useBackgroundCompletionNotifications } from "@/hooks/useBackgroundCompletionNotifications";
import { useSessionListRefreshCoordinator } from "@/hooks/useSessionListRefreshCoordinator";
import { FloatingSessionNotifications } from "./FloatingSessionNotifications";
import { useGlobalAttentionNotifications } from "@/hooks/useGlobalAttentionNotifications";
import { openNotificationTarget } from "@/lib/notification-navigation";
import { sendAgentCommand } from "@/lib/agent-client";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation, linkedSessionId, withTabOpen } from "@/lib/initial-navigation";
import { getTabOpen } from "@/lib/tab-session";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import { DEFAULT_PENDING_NEW_SESSION_CONTROL, type PendingNewSessionControl } from "@/lib/pending-new-session";
import type { ChatInputHandle } from "./ChatInput";
import { AppTopPanels } from "./AppTopPanels";
import { getLastSettingsSection, settingsSectionRequiresProject, type SettingsSection } from "@/lib/settings-navigation";
import { getAgentsBadge, getSessionFamily, isHiddenRelation, sideChatNameFrom, sideChatTitle } from "@/lib/session-family";
import { DebugPanel, DebugPanelBoundary } from "./DebugPanel";
import { focusIfLost } from "@/lib/stacked-dialog";
import { startPageVisibilityTracking } from "@/lib/page-debug";
import type { DebugClientSession } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { PRESET_READ_ONLY, type ToolEntry } from "@/lib/tool-presets";

// pi 内置工具中从不改动文件的那些；其他工具都可能写文件（#1144）。
const READ_ONLY_TOOL_NAMES = new Set<string>(PRESET_READ_ONLY);
const TOOL_END_REFRESH_MS = 1000;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation, setInitialNavigation] = useState(() => getInitialNavigation(searchParams ?? new URLSearchParams()));
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  // 主题订阅必须挂在应用根部并全程存活：只有 useTheme 被挂载时才会监听系统配色变化，
  // 否则跟随系统的页面在系统切换深浅色后不会更新 data-theme，代码块等背景会停留在旧主题。
  useTheme();
  // 未打开设置与输入框时也要恢复自定义字体。
  useFontPreferences();
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const handleInitialQuotePromptConsumed = useCallback((sessionId: string, prompt: string) => {
    setPendingQuotePrompt((current) => (
      current?.sessionId === sessionId && current.text === prompt ? null : current
    ));
  }, []);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatReadingPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatReadingPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !initialNavigation.sidebarCollapsed);
  const desktopSidebarOpenRef = useRef(!initialNavigation.sidebarCollapsed);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  // 子代理与开发服务器预览标签与文件、终端标签并列；激活时覆盖文件标签，切换项目时随旧项目一起丢弃。
  const [overlayTabs, setOverlayTabs] = useState<OverlayTab[]>([]);
  // The plain Settings button opens a phone's Settings on its list of sections; shortcuts open theirs.
  const [settingsOpenAtHome, setSettingsOpenAtHome] = useState(false);
  // `/side <prompt>`: the text that seeds the side chat's composer, until its panel consumes it.
  const [sideChatPrompts, setSideChatPrompts] = useState<Record<string, string>>({});
  // Sessions that finished while the tab was out of sight (#1484): the favicon keeps their
  // badge until the tab is opened again; never persisted, never dotted.
  const [hiddenFinishedSessionIds, setHiddenFinishedSessionIds] = useState<Set<string>>(new Set());
  const [activeOverlayTabId, setActiveOverlayTabId] = useState<string | null>(null);
  const closeMobileSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
    } catch {
      // 浏览器存储不可用时保留当前页面状态。
    }
  }, []);

  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem("pi-quote-selection-enabled", String(enabled));
    } catch {
      // 浏览器存储不可用时保留当前页面状态。
    }
  }, []);
  const {
    activateTab: activatePanelTab,
    activeTabId: activeFileTabId,
    clear: clearFileTabs,
    close: closeFilePanel,
    closeTab: closeFileTab,
    isOpen: rightPanelOpen,
    open: openFilePanel,
    openFile: openFileTab,
    saveViewerState: saveFileViewerStateForTab,
    selectTab: selectFileTab,
    switchWorkspace: switchFileWorkspaceTabs,
    tabs: fileTabs,
    toggle: toggleFilePanelState,
    workspaceGeneration: fileWorkspaceGeneration,
  } = useFilePanel({ isMobile, onMobileOpen: closeMobileSidebar });
  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; page?: number },
  ) => {
    setActiveTerminalTabId(null);
    setActiveOverlayTabId(null);
    openFileTab(filePath, fileName, options);
  }, [openFileTab]);
  const toggleFilePanel = useCallback(() => {
    if (fileTabs.length > 0 || terminalTabs.length > 0 || overlayTabs.length > 0) toggleFilePanelState();
  }, [overlayTabs.length, fileTabs.length, terminalTabs.length, toggleFilePanelState]);
  const [panelTabOrder, setPanelTabOrder] = useState<string[]>([]);
  const panelTabs: Tab[] = orderPanelTabs([...fileTabs, ...terminalTabs.map((tab) => ({
    id: tab.id,
    label: getFileName(tab.cwd) || tab.cwd,
    filePath: tab.cwd,
    kind: "terminal" as const,
    closing: Boolean(tab.closing),
  })), ...overlayTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    filePath: tab.kind === "agent" ? tab.sessionId : tab.serverId,
    kind: tab.kind === "agent" && tab.side ? "side" as const : tab.kind,
  }))], panelTabOrder);
  // A closed tab leaves the saved order, so reopening it appends it like any new tab.
  const panelTabIds = panelTabs.map((tab) => tab.id).join("\n");
  useEffect(() => {
    const open = new Set(panelTabIds.split("\n"));
    setPanelTabOrder((order) => order.every((id) => open.has(id)) ? order : order.filter((id) => open.has(id)));
  }, [panelTabIds]);
  const activePanelTabId = activeTerminalTabId ?? activeOverlayTabId ?? activeFileTabId;
  const activeOverlayTab = activeTerminalTabId === null && activeOverlayTabId
    ? overlayTabs.find((tab) => tab.id === activeOverlayTabId) ?? null
    : null;
  const handleSelectPanelTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setActiveTerminalTabId(tabId);
      setActiveOverlayTabId(null);
      activatePanelTab(tabId);
      return;
    }
    if (overlayTabs.some((tab) => tab.id === tabId)) {
      setActiveTerminalTabId(null);
      setActiveOverlayTabId(tabId);
      openFilePanel();
      return;
    }
    setActiveTerminalTabId(null);
    setActiveOverlayTabId(null);
    selectFileTab(tabId);
  }, [activatePanelTab, openFilePanel, overlayTabs, selectFileTab, terminalTabs]);
  const handleFileViewerStateChange = useCallback((generation: number, tabId: string, viewerRevision: number, viewerState: import("@/lib/file-viewer-state").FileViewerState) => {
    saveFileViewerStateForTab(generation, tabId, viewerRevision, viewerState);
  }, [saveFileViewerStateForTab]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveTerminalTabId(saved.activeId);
        activatePanelTab(saved.activeId);
        if (!saved.open) closeFilePanel();
      }
    } catch { /* sessionStorage 不可用时跳过恢复。 */ }
    setTerminalsRestored(true);
  }, [activatePanelTab, closeFilePanel]);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeTerminalTabId,
        open: rightPanelOpen,
      }));
    } catch { /* sessionStorage 不可用不影响终端运行。 */ }
  }, [activeTerminalTabId, rightPanelOpen, terminalTabs, terminalsRestored]);
  const {
    activePanel: activeTopPanel,
    close: closeTopPanel,
    closeDebug: closeDebugPanelState,
    open: openTopPanel,
    position: topPanelPos,
    toggle: toggleTopPanel,
    topBarRef,
  } = useTopPanel({ isMobile, onMobileOpen: closeMobileSidebar });
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const viewportHeight = useViewportHeight();
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const rightPanelFullWidth = rightPanelOpen && rightPanelExpanded && !isMobile;
  useEffect(() => {
    if (rightPanelFullWidth) closeTopPanel();
  }, [rightPanelFullWidth, closeTopPanel]);
  useEffect(() => { if (!rightPanelOpen || isMobile) setRightPanelExpanded(false); }, [rightPanelOpen, isMobile]);
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions must not change the remembered desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);

  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [systemPromptLoading, setSystemLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemToolsLoading, setSystemToolsLoading] = useState(false);
  const toolsLoaderRef = useRef<(() => Promise<ToolEntry[]>) | null>(null);
  const toolsLoadIdRef = useRef(0);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemLoading(false);
  }, []);

  const handleToolsLoaderChange = useCallback((loader: (() => Promise<ToolEntry[]>) | null) => {
    toolsLoadIdRef.current += 1;
    toolsLoaderRef.current = loader;
    setSystemToolsLoading(false);
  }, []);

  const handleTopPanelToggle = useCallback((panel: TopPanel) => {
    const openingSystemPrompt = panel === "system" && activeTopPanel !== "system";
    const openingTools = panel === "tools" && activeTopPanel !== "tools";
    toggleTopPanel(panel);
    if (openingSystemPrompt && !systemPromptLoading) {
      const load = systemPromptLoaderRef.current;
      if (load) {
        const loadId = ++systemPromptLoadIdRef.current;
        setSystemLoading(true);
        void load().catch((error: unknown) => {
          console.error("加载系统提示词失败:", error);
        }).finally(() => {
          if (systemPromptLoadIdRef.current === loadId) setSystemLoading(false);
        });
      }
    }
    if (openingTools && !systemToolsLoading) {
      const load = toolsLoaderRef.current;
      if (load) {
        const loadId = ++toolsLoadIdRef.current;
        setSystemToolsLoading(true);
        void load().then((tools) => {
          if (toolsLoadIdRef.current === loadId) setSystemTools(tools);
        }).catch((error: unknown) => {
          console.error("加载工具定义失败:", error);
        }).finally(() => {
          if (toolsLoadIdRef.current === loadId) setSystemToolsLoading(false);
        });
      }
    }
  }, [activeTopPanel, systemPromptLoading, systemToolsLoading, toggleTopPanel]);

  const {
    branchActiveLeafId,
    branchTree,
    contextUsage,
    copiedField: copiedSessionField,
    copySessionField: handleCopySessionField,
    onBranchDataChange: handleBranchDataChange,
    onBranchLeafChange: handleBranchLeafChange,
    onContextUsageChange: handleContextUsageChange,
    onShadowControlChange: handleShadowMindControlChange,
    onStatsChange: handleSessionStatsChange,
    onSystemPromptChange: handleSystemPromptChange,
    reset: resetSessionViews,
    shadowControl: shadowSessionControl,
    stats: sessionStats,
    systemPrompt,
    updateStatsTitle,
  } = useSessionPresentation({ closeTopPanel });
  const refreshSessions = useCallback(() => setRefreshKey((key) => key + 1), []);
  const {
    applyGeneratedTitle,
    beginInitialCwd,
    bumpSessionKey,
    completeInitialRestore,
    consumeCwdSyncSuppression,
    dispatchPending: dispatchPendingNewSession,
    initialSessionRestored,
    markInitialRestorePending,
    isActiveSession,
    isNavigationActive,
    leaveWorkspace,
    newSession: handleNewSession,
    newSessionCwd,
    notificationSessionLocateRequest,
    pendingNewSessions,
    restoreWorkspaceContext,
    selectSession: handleSelectSession,
    selectedSession,
    sessionCreated: handleSessionCreated,
    sessionCreatedInBackground: handleSessionCreatedInBackground,
    sessionDeleted: handleSessionDeleted,
    sessionForked: handleSessionForked,
    sessionKey,
    syncWorkspaceKey,
    updateDraftCwd,
  } = useSessionNavigation({
    initialSessionId: initialNavigation.sessionId,
    isMobile,
    onMobileSelect: closeMobileSidebar,
    onRefresh: refreshSessions,
    resetSessionViews,
  });
  // 会话记忆只在挂载后读取，避免 SSR 和客户端首帧因 sessionStorage 不同而水合失败。
  useLayoutEffect(() => {
    const next = withTabOpen(initialNavigation, getTabOpen());
    if (next === initialNavigation) return;
    if (next.sessionId) markInitialRestorePending();
    setInitialNavigation(next);
  }, [initialNavigation, markInitialRestorePending]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      entryId: sourceEntryId,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    handleSessionForked(result.newSessionId);
  }, [handleSessionForked, translate]);
  const sessionsWithSelection = useMemo(() => selectedSession
    ? [...sessionCatalog.filter((session) => session.id !== selectedSession.id), selectedSession]
    : sessionCatalog, [selectedSession, sessionCatalog]);
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const {
    dismissNotification,
    notificationController,
    notifications: floatingNotifications,
  } = useSessionNotifications(selectedSession?.id ?? null);
  const { notifySession } = notificationController;
  const getNotificationFolderName = useCallback((sessionId: string) => {
    const cwd = sessionsWithSelection.find((session) => session.id === sessionId)?.cwd;
    return cwd ? getFileName(cwd) || undefined : undefined;
  }, [sessionsWithSelection]);
  useGlobalAttentionNotifications({
    notifySession,
    attentionTitle: translate("chat.notificationAttentionTitle"),
    attentionBody: translate("chat.notificationAttentionBody"),
  });
  const handleSidebarSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    handleSelectSession(session, isRestore);
  }, [handleSelectSession]);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current?.sessionId === target.sessionId && current.entryId === target.entryId ? null : current);
  }, []);
  const { runningSessionIds, awaitingInputSessionIds, startingSessions, subagentsActiveSessionIds, sessionListVersion } = useRunningSessions();
  const runningSessionTransitions = useRunningSessionTransitions(runningSessionIds, selectedSession?.id ?? null, subagentsActiveSessionIds);
  // The debug panel's reader of the chat's own state: kept in a ref, so registering renders
  // nothing, and read only by the open panel (DebugPanel), never on AppShell's renders.
  const debugSnapshotReaderRef = useRef<(() => DebugClientSession) | null>(null);
  const handleDebugSnapshotReaderChange = useCallback((reader: (() => DebugClientSession) | null) => {
    debugSnapshotReaderRef.current = reader;
  }, []);
  // The panel reports the page's visibility history from the first mount on, opened or not.
  useEffect(() => {
    startPageVisibilityTracking();
  }, []);
  // Escape inside the debug panel gives focus back to the Debug button once the panel is gone.
  const closeDebugPanel = useCallback((restoreFocus: boolean) => {
    closeDebugPanelState();
    if (restoreFocus) requestAnimationFrame(() => focusIfLost(document, document.querySelector<HTMLElement>("[data-debug-button]")));
  }, [closeDebugPanelState]);
  useBackgroundCompletionNotifications(
    runningSessionTransitions,
    notifySession,
    translate("i18n.sessionComplete"),
    translate("chat.notificationDoneBody"),
    getNotificationFolderName,
  );

  const {
    generate: handleAutoName,
    status: autoNameStatus,
  } = useSessionAutoName({
    applyGeneratedTitle,
    closeTopPanel,
    isActiveSession,
    onRefresh: refreshSessions,
    sessionId: selectedSession?.id ?? null,
    updateStatsTitle,
  });

  const openSessionStatsPanel = useCallback(() => openTopPanel("session"), [openTopPanel]);

  // The composer opens Settings too: a bare /mcp opens Settings › MCP (useAgentSession).
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsOpenAtHome(false);
    setSettingsSection(section);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) closeTopPanel();
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [closeTopPanel, isMobile]);

  // 移动端右侧面板与侧栏会盖住聊天区，插入提及后回到输入框才看得到结果；桌面端并排显示，保持原状。
  const revealChatAfterMention = useCallback(() => {
    if (!isMobile) return;
    closeFilePanel();
    closeMobileSidebar();
  }, [closeFilePanel, closeMobileSidebar, isMobile]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    revealChatAfterMention();
  }, [revealChatAfterMention]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (!mentions) return;
    chatInputRef.current?.insertText(mentions);
    revealChatAfterMention();
  }, [revealChatAfterMention]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    revealChatAfterMention();
  }, [revealChatAfterMention]);

  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectRootRef = useRef<string | null>(null);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        beginInitialCwd(data.cwd);
        setInitialCwdStatus("ready");
        if (!new URLSearchParams(window.location.search).get("cwd")) {
          router.replace(`?cwd=${encodeURIComponent(data.cwd)}`, { scroll: false });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [beginInitialCwd, initialNavigation]);
  const worktreeCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const { snapshot: worktreeState } = useWorktreeState(worktreeCwd);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    // URL 链接的会话已不存在时，这次采用的项目保持空白新会话，不恢复其上次打开的会话（#1168）。
    const skipWorkspaceRestore = skipWorkspaceRestoreRef.current;
    skipWorkspaceRestoreRef.current = false;
    const newProject = projectKey ?? projectRoot ?? cwd;
    syncWorkspaceKey(newProject);
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (consumeCwdSyncSuppression()) return;
    // Selecting an existing session updates the sidebar cwd in a separate
    // effect. That notification can arrive after selectedSession has changed;
    // never interpret the session's own cwd synchronization as a request to
    // close the session and open a blank new-session view.
    if (selectedSession?.cwd === cwd) return;
    // 点击“新增会话”后，侧栏会继续同步目标 cwd；此时必须保留显式创建意图，
    // 不能把该同步误判为普通工作区切换并恢复上次打开的旧会话。
    if (!selectedSession && newSessionCwd === cwd) return;
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    leaveWorkspace(cwd);
    // 保持项目隔离，但暂存离开项目的文件标签，切回时恢复（d69b33e）。
    // 子代理标签属于旧项目的会话，直接丢弃；终端跨项目保留，激活中的终端继续占用面板。
    const keepPanelForTerminal = activeTerminalTabId !== null && rightPanelOpen;
    switchFileWorkspaceTabs(currentProject, newProject);
    setOverlayTabs([]);
    setActiveOverlayTabId(null);
    if (keepPanelForTerminal) activatePanelTab(activeTerminalTabId);
    if (!skipWorkspaceRestore) restoreWorkspaceContext(newProject);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [activatePanelTab, activeTerminalTabId, consumeCwdSyncSuppression, leaveWorkspace, newSessionCwd, restoreWorkspaceContext, rightPanelOpen, router, selectedSession, switchFileWorkspaceTabs, syncWorkspaceKey]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });


  // The badge is for an unseen tab: opening it puts the finished chat on screen (#1484).
  useEffect(() => {
    const clearIfSeen = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      setHiddenFinishedSessionIds((prev) => (prev.size === 0 ? prev : new Set()));
    };
    clearIfSeen();
    document.addEventListener("visibilitychange", clearIfSeen);
    window.addEventListener("focus", clearIfSeen);
    return () => {
      document.removeEventListener("visibilitychange", clearIfSeen);
      window.removeEventListener("focus", clearIfSeen);
    };
  }, []);

  const handleAgentEnd = useCallback(() => {
    if (selectedSession && !isHiddenRelation(selectedSession.relation)
      && (document.visibilityState !== "visible" || !document.hasFocus())) {
      const finishedId = selectedSession.id;
      setHiddenFinishedSessionIds((prev) => (prev.has(finishedId) ? prev : new Set(prev).add(finishedId)));
    }
    setExplorerRefreshKey((k) => k + 1);
  }, [selectedSession]);

  const handleSessionListRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);
  const requestAgentSessionListRefresh = useSessionListRefreshCoordinator(handleSessionListRefresh);


  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  // 运行中写入的文件随时出现在文件树里，而不只在结束时（#1144）：只读工具以外的工具结束后，每秒最多刷新一次。
  const toolEndRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleToolEnd = useCallback((toolName: string) => {
    if (READ_ONLY_TOOL_NAMES.has(toolName) || toolEndRefreshTimerRef.current) return;
    toolEndRefreshTimerRef.current = setTimeout(() => {
      toolEndRefreshTimerRef.current = null;
      setExplorerRefreshKey((k) => k + 1);
    }, TOOL_END_REFRESH_MS);
  }, []);
  useEffect(() => () => {
    if (toolEndRefreshTimerRef.current) clearTimeout(toolEndRefreshTimerRef.current);
  }, []);


  // 侧栏在初始会话不在列表中时调用。只有该 id 来自 URL（而非本标签页的记忆）时才跳过工作区恢复。
  const skipWorkspaceRestoreRef = useRef(false);
  const initialLinkedSessionId = linkedSessionId(initialNavigation);
  const handleInitialRestoreDone = useCallback(() => {
    completeInitialRestore();
    if (initialLinkedSessionId) skipWorkspaceRestoreRef.current = true;
  }, [completeInitialRestore, initialLinkedSessionId]);




  const handleOpenLinkedFile = useCallback((filePath: string, page?: number) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null, page });
  }, [handleOpenFile, selectedSession?.id]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveTerminalTabId(tab.id);
    setActiveOverlayTabId(null);
    activatePanelTab(tab.id);
    if (isMobile) setSidebarOpen(false);
  }, [activatePanelTab, terminalTabs, isMobile]);

  // Subagent work opens in a right-panel tab instead of hijacking the main chat.
  const handleOpenSubagentTab = useCallback((sessionId: string, label: string, side?: boolean) => {
    const id = agentOverlayTabId(sessionId);
    setOverlayTabs((prev) => {
      if (prev.some((tab) => tab.id === id)) return prev;
      // Every side chat has the same name, and `/side` can be used again and
      // again: the lowest number no open tab shows tells them apart.
      let numbered = label;
      for (let number = 2; side && prev.some((tab) => tab.label === numbered); number += 1) numbered = `${label} ${number}`;
      return [...prev, { id, kind: "agent" as const, sessionId, label: numbered, ...(side ? { side: true } : {}) }];
    });
    setActiveTerminalTabId(null);
    setActiveOverlayTabId(id);
    openFilePanel();
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, openFilePanel]);

  // A dev server's preview opens beside files and terminals, like a subagent.
  const handleOpenServerPreview = useCallback((serverId: string, label: string) => {
    const id = serverOverlayTabId(serverId);
    setOverlayTabs((prev) => prev.some((tab) => tab.id === id) ? prev : [...prev, { id, kind: "server", serverId, label }]);
    setActiveTerminalTabId(null);
    setActiveOverlayTabId(id);
    openFilePanel();
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, openFilePanel]);

  // The agent switcher's side-panel button: opens a subagent's tab, or closes
  // it when the open panel already has it (the panel closes with its last tab).
  // The switcher stays open beside the panel, except on phones, where the
  // panel covers the chat.
  const openSubagentTabIds = useMemo(
    () => new Set(rightPanelOpen ? overlayTabs.flatMap((tab) => tab.kind === "agent" ? [tab.sessionId] : []) : []),
    [overlayTabs, rightPanelOpen],
  );
  const handleToggleSubagentTab = (sessionId: string, label: string, side?: boolean) => {
    if (openSubagentTabIds.has(sessionId)) {
      handleClosePanelTab(agentOverlayTabId(sessionId));
      return;
    }
    if (isMobile) closeTopPanel();
    handleOpenSubagentTab(sessionId, label);
  };

  // `/side` landed (hooks/useAgentSession): open the forked chat's tab, seed
  // its composer when the command carried a prompt, and refresh the list so
  // the family's badge folds the new member in.
  const handleSideSession = useCallback((session: SessionInfo, prompt: string | null) => {
    if (prompt) setSideChatPrompts((prev) => ({ ...prev, [session.id]: prompt }));
    setSessionCatalog((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
    const label = translate("agentSwitcher.sideChat");
    const parentId = session.relation?.kind === "side" ? session.relation.parentSessionId : null;
    if (parentId && parentId !== sideTabOwnerRef.current) {
      // The fork landed after the main chat moved on: the tab waits with its own session.
      try {
        const key = sideTabsKey(parentId);
        window.sessionStorage.setItem(key, appendSideTab(window.sessionStorage.getItem(key), session.id, label));
      } catch { /* storage is optional */ }
    } else {
      handleOpenSubagentTab(session.id, label, true);
    }
    setRefreshKey((key) => key + 1);
  }, [handleOpenSubagentTab, translate]);

  // The switcher's New side chat, on the main agent's row, whichever family member the main chat shows.
  const handleNewSideChat = useCallback(async (rootSessionId: string) => {
    const result = await createSideChat(rootSessionId, translate);
    if ("error" in result) return result.error;
    if (isMobile) closeTopPanel();
    handleSideSession(result.session, null);
    return null;
  }, [closeTopPanel, handleSideSession, isMobile, translate]);

  // A side chat's first prompt names it: read the name when a run in an open tab starts or ends.
  const runningSideTabs = overlayTabs.flatMap((tab) => tab.kind === "agent" && tab.side && runningSessionIds.has(tab.sessionId) ? [tab.sessionId] : []).join();
  useEffect(() => {
    if (runningSideTabs) setRefreshKey((key) => key + 1);
  }, [runningSideTabs]);

  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    if (activeTerminalTabId === tab.id) {
      const nextTerminalId = replacement?.id ?? remaining.at(-1)?.id ?? null;
      setActiveTerminalTabId(nextTerminalId);
      if (nextTerminalId) activatePanelTab(nextTerminalId);
      else if (overlayTabs.length > 0) setActiveOverlayTabId(overlayTabs.at(-1)!.id);
      else if (fileTabs.length === 0) closeFilePanel();
    }
  };

  const handleClosePanelTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    if (overlayTabs.some((tab) => tab.id === tabId)) {
      const remainingOverlays = overlayTabs.filter((tab) => tab.id !== tabId);
      setOverlayTabs(remainingOverlays);
      if (activeOverlayTabId !== tabId) return;
      const nextOverlay = remainingOverlays.at(-1);
      if (nextOverlay) {
        setActiveOverlayTabId(nextOverlay.id);
      } else {
        setActiveOverlayTabId(null);
        const nextTerminalId = terminalTabs.at(-1)?.id ?? null;
        if (nextTerminalId) {
          setActiveTerminalTabId(nextTerminalId);
          activatePanelTab(nextTerminalId);
        } else if (fileTabs.length === 0) {
          closeFilePanel();
        }
      }
      return;
    }
    const closingActiveFile = activeTerminalTabId === null && activeOverlayTabId === null && activeFileTabId === tabId;
    const remainingFiles = fileTabs.filter((tab) => tab.id !== tabId);
    closeFileTab(tabId);
    if (closingActiveFile && remainingFiles.length === 0) {
      const nextTerminalId = terminalTabs.at(-1)?.id ?? null;
      const nextOverlay = overlayTabs.at(-1);
      if (nextTerminalId) {
        setActiveTerminalTabId(nextTerminalId);
        activatePanelTab(nextTerminalId);
      } else if (nextOverlay) {
        setActiveOverlayTabId(nextOverlay.id);
        openFilePanel();
      }
    }
  }, [activatePanelTab, activeOverlayTabId, activeFileTabId, activeTerminalTabId, overlayTabs, closeFileTab, closeFilePanel, fileTabs, openFilePanel, terminalTabs]);

  const handleCloseAllFileTabs = useCallback(() => {
    const nextTerminalId = activeTerminalTabId ?? (activeOverlayTabId ? null : terminalTabs.at(-1)?.id ?? null);
    const nextAgentId = nextTerminalId ? null : activeOverlayTabId ?? overlayTabs.at(-1)?.id ?? null;
    clearFileTabs();
    setActiveTerminalTabId(nextTerminalId);
    setActiveOverlayTabId(nextAgentId);
    if (nextTerminalId) activatePanelTab(nextTerminalId);
    else if (nextAgentId) openFilePanel();
  }, [activatePanelTab, activeOverlayTabId, activeTerminalTabId, overlayTabs, clearFileTabs, openFilePanel, terminalTabs]);

  // The Agents switcher's Delete on a side chat: its tab goes with it, and the
  // main chat showing it goes back to the parent, as the Main agent row does
  // (`handleSessionDeleted` would leave the family for a fresh composer).
  const handleDeleteSideChat = useCallback(async (sessionId: string, root: SessionInfo): Promise<string | null> => {
    const result = await deleteSideChat(sessionId);
    if (result) return result.error;
    handleClosePanelTab(agentOverlayTabId(sessionId));
    if (selectedSession?.id === sessionId) {
      handleSelectSession(root);
      setRefreshKey((key) => key + 1);
    } else {
      handleSessionDeleted(sessionId);
    }
    return null;
  }, [handleClosePanelTab, handleSelectSession, handleSessionDeleted, selectedSession?.id]);

  // Side tabs follow their main session (saved in this browser tab, restored on return or reload);
  // subagent tabs stay open within a project.
  const sideTabOwner = activeSessionFamily?.root.id ?? null;
  const sideTabOwnerRef = useRef<string | null>(null);
  const sideTabsRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionCatalog.length === 0) return;
    if (sideTabsRestoredRef.current && sideTabOwnerRef.current === sideTabOwner) {
      if (!sideTabOwner) return;
      try {
        const tabs = overlayTabs.flatMap((tab) => tab.kind === "agent" && tab.side ? [{ sessionId: tab.sessionId, label: tab.label, side: true as const }] : []);
        if (tabs.length === 0) window.sessionStorage.removeItem(sideTabsKey(sideTabOwner));
        else window.sessionStorage.setItem(sideTabsKey(sideTabOwner), JSON.stringify({ tabs, activeId: activeOverlayTabId, open: rightPanelOpen }));
      } catch { /* storage is optional */ }
      return;
    }
    sideTabsRestoredRef.current = true;
    sideTabOwnerRef.current = sideTabOwner;
    let restored: ReturnType<typeof restoreSideTabs> = { tabs: [], activeId: null, open: false };
    if (sideTabOwner) {
      try {
        restored = restoreSideTabs(window.sessionStorage.getItem(sideTabsKey(sideTabOwner)), sideTabOwner, sessionCatalog);
      } catch { /* storage is optional */ }
    }
    setOverlayTabs((tabs) => [
      ...tabs.filter((tab) => !(tab.kind === "agent" && tab.side)),
      ...restored.tabs.map((tab) => ({ id: agentOverlayTabId(tab.sessionId), kind: "agent" as const, sessionId: tab.sessionId, label: tab.label, side: true })),
    ]);
    const restoredActive = restored.activeId === agentOverlayTabId(selectedSession?.id ?? "") ? null : restored.activeId;
    setActiveOverlayTabId(restoredActive);
    if (restoredActive) {
      setActiveTerminalTabId(null);
      if (restored.open) openFilePanel();
    } else if (fileTabs.length === 0 && terminalTabs.length === 0 && !overlayTabs.some((tab) => !(tab.kind === "agent" && tab.side))) {
      // The panel held only the previous session's side tabs: nothing is left to show.
      closeFilePanel();
    }
  }, [activeOverlayTabId, closeFilePanel, fileTabs.length, terminalTabs.length, openFilePanel, overlayTabs, rightPanelOpen, selectedSession?.id, sessionCatalog, sideTabOwner]);

  // One session, one chat: opening a subagent or side chat in the main chat closes its tab.
  const selectedSessionId = selectedSession?.id;
  useEffect(() => {
    if (selectedSessionId && overlayTabs.some((tab) => tab.kind === "agent" && tab.sessionId === selectedSessionId)) {
      handleClosePanelTab(agentOverlayTabId(selectedSessionId));
    }
  }, [overlayTabs, handleClosePanelTab, selectedSessionId]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const activeShadowScopeKey = selectedSession?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : null);
  const activeShadowSessionControl = shadowSessionControl?.scopeKey === activeShadowScopeKey
    ? shadowSessionControl
    : null;
  const pendingNewSessionControl: PendingNewSessionControl = effectiveNewSessionCwd
    ? (pendingNewSessions.get(effectiveNewSessionCwd) ?? DEFAULT_PENDING_NEW_SESSION_CONTROL)
    : DEFAULT_PENDING_NEW_SESSION_CONTROL;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;
  const handleProjectTrusted = useCallback(() => {
    setModelsRefreshKey((key) => key + 1);
    bumpSessionKey();
  }, [bumpSessionKey]);
  const {
    busy: projectTrustBusy,
    closeDialog: closeProjectTrustDialog,
    dialogOpen: projectTrustDialogOpen,
    error: projectTrustError,
    openDialog: openProjectTrustDialog,
    status: projectTrust,
    trust: handleTrustProject,
    updateStatus: handleProjectTrustChanged,
  } = useProjectTrust({ cwd: projectTrustCwd, onTrusted: handleProjectTrusted });

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        selectedSession={selectedSession}
        onSelectSession={handleSidebarSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialNavigation.sessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey + (sessionListVersion ?? 0)}
        onSessionDeleted={handleSessionDeleted}
        runningSessionIds={runningSessionIds}
        awaitingInputSessionIds={awaitingInputSessionIds}
        startingSessions={startingSessions}
        runningSessionTransitions={runningSessionTransitions}
        locateSessionRequest={notificationSessionLocateRequest}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        worktreeState={worktreeState}
        onOpenFile={handleOpenFile}
        onOpenTerminal={handleOpenTerminal}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        hiddenFinishedSessionIds={hiddenFinishedSessionIds}
        onSessionsChange={setSessionCatalog}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = settingsSectionRequiresProject(section) && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => openSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setSettingsOpenAtHome(true);
            setSettingsSection(getLastSettingsSection(projectTrustCwd));
          }}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
      </div>
    </>
  );

  const filePanelToggle = (
    <button
      type="button"
      onClick={toggleFilePanel}
      aria-controls="file-panel"
      aria-expanded={rightPanelOpen}
      title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
      aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 36px",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div
      className="app-shell-root"
      style={{
        display: "flex",
        height: viewportHeight ?? "100dvh",
        overflow: "hidden",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        background: "var(--bg)",
      }}
    >
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        inert={rightPanelFullWidth}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          inert={rightPanelFullWidth}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <AppTopBar
          activePanel={activeTopPanel}
          endAction={filePanelToggle}
          locale={locale}
          navigation={{
            activeLeafId: branchActiveLeafId,
            branchTree,
            isMobile,
            onLeafChange: handleBranchLeafChange,
            onSidebarToggle: handleSidebarToggle,
            sidebarOpen,
            topBarRef,
          }}
          onTogglePanel={handleTopPanelToggle}
          session={{
            // The Agents panel also starts side chats, so it is there for any saved session.
            agentsBadge: activeSessionFamily ? getAgentsBadge(activeSessionFamily.subagents, runningSessionIds) : null,
            autoNameStatus,
            contextUsage,
            hasPersistedSession: Boolean(selectedSession),
            identityKey: selectedSession?.id ?? effectiveNewSessionCwd ?? "none",
            messageCount: selectedSession?.messageCount ?? 0,
            onAutoName: () => void handleAutoName(),
            onHistory: handleViewFullHistory,
            shadowControl: activeShadowSessionControl,
            show: showChat,
            stats: sessionStats,
            systemPrompt,
          }}
          translate={translate}
          trust={{
            needsTrust: Boolean(projectTrust?.requiresTrust && !projectTrust.trusted),
            onOpen: openProjectTrustDialog,
          }}
        />
          <AppTopPanels
            activePanel={activeTopPanel}
            agentFamily={activeSessionFamily}
            locale={locale}
            onCopySessionField={handleCopySessionField}
            onSelectSession={handleSelectSession}
            onToggleSubagentTab={handleToggleSubagentTab}
            openSubagentTabIds={openSubagentTabIds}
            onNewSideChat={() => activeSessionFamily ? handleNewSideChat(activeSessionFamily.root.id) : Promise.resolve(null)}
            onDeleteSideChat={(sessionId) => activeSessionFamily ? handleDeleteSideChat(sessionId, activeSessionFamily.root) : Promise.resolve(null)}
            position={topPanelPos}
            runningSessionIds={runningSessionIds}
            selectedSessionId={selectedSession?.id ?? null}
            session={{
              contextUsage,
              copiedField: copiedSessionField,
              isMobile,
              selectedSession,
              stats: sessionStats,
            }}
            systemPrompt={systemPrompt}
            systemPromptLoading={systemPromptLoading}
            tools={systemTools}
            toolsLoading={systemToolsLoading}
            translate={translate}
          />

          {activeTopPanel === "debug" && showChat && (
            <DebugPanelBoundary fallback={translate("debug.failed")}>
              <DebugPanel
                readerRef={debugSnapshotReaderRef}
                selectedSessionId={selectedSession?.id ?? null}
                sessions={sessionsWithSelection}
                onClose={closeDebugPanel}
              />
            </DebugPanelBoundary>
          )}

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
      <ChatWindow
              key={sessionKey}
              navigationKey={sessionKey}
              isNavigationActive={isNavigationActive}
              session={selectedSession}
              searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
              onSearchTargetHandled={handleSearchTargetHandled}
              initialScrollPosition={selectedSession ? sessionScrollPositionsRef.current.get(selectedSession.id) ?? null : null}
              onScrollPositionChange={handleSessionScrollPositionChange}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionWorktrees={effectiveNewSessionCwd && worktreeState?.worktrees.some((worktree) => worktree.path === effectiveNewSessionCwd)
                ? worktreeState.worktrees
                : []}
              pendingNewSessionControl={pendingNewSessionControl}
              onPendingNewSessionEvent={dispatchPendingNewSession}
              notificationController={notificationController}
              onNewSessionCwdChange={updateDraftCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionCreatedInBackground={handleSessionCreatedInBackground}
              onSessionListRefresh={requestAgentSessionListRefresh}
              onSessionForked={handleSessionForked}
              onSideSession={handleSideSession}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onDebugSnapshotReaderChange={handleDebugSnapshotReaderChange}
        onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
        onToolsLoaderChange={handleToolsLoaderChange}
              onShadowMindControlChange={handleShadowMindControlChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onOpenSettings={openSettingsSection}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
              onFilesUploaded={handleExplorerRefresh}
              onOpenSubagent={handleOpenSubagentTab}
              onOpenServerPreview={handleOpenServerPreview}
              onToolEnd={handleToolEnd}
              quoteSelectionEnabled={quoteSelectionEnabled}
              initialPrompt={pendingQuotePrompt && pendingQuotePrompt.sessionId === selectedSession?.id ? pendingQuotePrompt.text : undefined}
              onInitialPromptConsumed={handleInitialQuotePromptConsumed}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={closeFilePanel}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          inert={rightPanelFullWidth}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelFullWidth ? " right-panel-full-width" : ""}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={activePanelTabId ?? ""}
              onSelectTab={handleSelectPanelTab}
              onCloseTab={handleClosePanelTab}
              onReorderTab={(source, target, after) => setPanelTabOrder(movePanelTab(panelTabs.map((tab) => tab.id), source, target, after))}
            />
          </div>
          {rightPanelOpen && isMobile && (
            <button type="button" className="file-viewer-icon-button"
              title={translate("files.hidePanel")}
              aria-label={translate("files.hidePanel")}
              onClick={closeFilePanel}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          )}
          {rightPanelOpen && !isMobile && (
            <button type="button" className="file-viewer-icon-button"
              aria-pressed={rightPanelFullWidth}
              title={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
              aria-label={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
              onClick={() => setRightPanelExpanded((current) => !current)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 3H3v5M16 21h5v-5M3 3l7 7M21 21l-7-7" /></svg>
            </button>
          )}
          {fileTabs.length > 0 && (
            <button
              type="button"
              className="file-viewer-icon-button"
              onClick={handleCloseAllFileTabs}
              title={translate("files.closeAllTabs")}
              aria-label={translate("files.closeAllTabs")}
              style={{ margin: "0 6px", border: "none" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 15V5a2 2 0 0 1 2-2h10" />
                <path d="M8 19H6a2 2 0 0 1-2-2" />
                <path d="M8 7h8a2 2 0 0 1 2 2v2" />
                <path d="m13 14 7 7" />
                <path d="m20 14-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {!activeTerminalTabId && !activeOverlayTab && activeFileTab?.filePath ? (
            <FileViewer
              key={`${fileWorkspaceGeneration}:${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialPage={activeFileTab.page}
              initialState={activeFileTab.viewerState}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                fileWorkspaceGeneration,
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              watchEnabled={rightPanelOpen}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath, page) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId, page },
              )}
            />
          ) : !activeTerminalTabId && !activeOverlayTab ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeTerminalTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                active={rightPanelOpen && tab.id === activeTerminalTabId}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCloseError={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item))}
              />
            </div>
          ))}
          {activeOverlayTab?.kind === "server" && (
            <DevServerViewer
              key={activeOverlayTab.serverId}
              serverId={activeOverlayTab.serverId}
              fallbackLabel={activeOverlayTab.label}
            />
          )}
          {activeOverlayTab?.kind === "agent" && activeOverlayTab.side && (
            <SessionChatPanel
              key={activeOverlayTab.sessionId}
              sessionId={activeOverlayTab.sessionId}
              running={runningSessionIds.has(activeOverlayTab.sessionId)}
              initialPrompt={sideChatPrompts[activeOverlayTab.sessionId]}
              onInitialPromptConsumed={() => setSideChatPrompts((prev) => {
                if (!(activeOverlayTab.sessionId in prev)) return prev;
                const next = { ...prev };
                delete next[activeOverlayTab.sessionId];
                return next;
              })}
              modelsRefreshKey={modelsRefreshKey}
              notificationController={notificationController}
              onOpenFile={handleOpenLinkedFile}
              onOpenSubagent={handleOpenSubagentTab}
              onSessionForked={handleSessionForked}
              onOpenSettings={openSettingsSection}
              onToolEnd={handleToolEnd}
              onFilesUploaded={handleExplorerRefresh}
              quoteSelectionEnabled={quoteSelectionEnabled}
            />
          )}
          {activeOverlayTab?.kind === "agent" && !activeOverlayTab.side && (
            <SubagentViewer
              key={activeOverlayTab.sessionId}
              sessionId={activeOverlayTab.sessionId}
              fallbackLabel={activeOverlayTab.label}
              running={runningSessionIds.has(activeOverlayTab.sessionId)}
              onOpenFile={handleOpenLinkedFile}
            />
          )}
        </div>
      </div>
    </div>
    <FloatingSessionNotifications
      notifications={floatingNotifications}
      closeLabel={translate("i18n.close")}
      regionLabel={translate("chat.inAppNotifications")}
      openSessionLabel={(title, body) => translate("chat.openNotificationSession", { title, body })}
      onDismiss={dismissNotification}
      onNavigate={openNotificationTarget}
    />
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        openAtHome={settingsOpenAtHome}
        quoteSelectionEnabled={quoteSelectionEnabled}
        onQuoteSelectionChange={handleQuoteSelectionChange}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
        onSessionReloaded={bumpSessionKey}
        projectTrust={projectTrust}
        onOpenTrustDialog={openProjectTrustDialog}
        onProjectTrustChanged={handleProjectTrustChanged}
      />
    )}
    {/* After Settings, so it opens above it (z-index 1100 over 1000) when Settings › MCP asks for it. */}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={closeProjectTrustDialog}
        onConfirm={() => void handleTrustProject()}
        onStatus={(status) => handleProjectTrustChanged(projectTrustCwd, status)}
      />
    )}
    </>
  );
}
