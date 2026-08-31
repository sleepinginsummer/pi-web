"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar } from "./TabBar";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { AppTopBar } from "./AppTopBar";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
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
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
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
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { getSessionFamily } from "@/lib/session-family";
import type { SessionInfo } from "@/lib/types";
import type { ToolEntry } from "@/lib/tool-presets";

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams ?? new URLSearchParams()));
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const closeMobileSidebar = useCallback(() => setSidebarOpen(false), []);
  const {
    activeTabId: activeFileTabId,
    clear: clearFilePanel,
    close: closeFilePanel,
    closeTab: handleCloseFileTab,
    isOpen: rightPanelOpen,
    openFile: handleOpenFile,
    saveViewerState: saveFileViewerStateForTab,
    selectTab: setActiveFileTabId,
    tabs: fileTabs,
    toggle: toggleFilePanel,
  } = useFilePanel({ isMobile, onMobileOpen: closeMobileSidebar });
  const handleFileViewerStateChange = useCallback((tabId: string, viewerRevision: number, viewerState: import("@/lib/file-viewer-state").FileViewerState) => {
    saveFileViewerStateForTab(tabId, viewerRevision, viewerState);
  }, [saveFileViewerStateForTab]);
  const {
    activePanel: activeTopPanel,
    close: closeTopPanel,
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
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
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
    isActiveSession,
    leaveWorkspace,
    newSession: handleNewSession,
    newSessionCwd,
    pendingNewSessions,
    restoreWorkspaceContext,
    selectSession: handleSelectSession,
    selectedSession,
    sessionCreated: handleSessionCreated,
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
  useGlobalAttentionNotifications({
    notifySession,
    attentionTitle: translate("chat.notificationAttentionTitle"),
    attentionBody: translate("chat.notificationAttentionBody"),
  });
  const { runningSessionIds } = useRunningSessions();
  const runningSessionTransitions = useRunningSessionTransitions(runningSessionIds, selectedSession?.id ?? null);
  useBackgroundCompletionNotifications(
    runningSessionTransitions,
    notifySession,
    translate("i18n.sessionComplete"),
    translate("chat.notificationDoneBody"),
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

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) closeTopPanel();
    setSidebarOpen((open) => !open);
  }, [closeTopPanel, isMobile]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

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
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [beginInitialCwd, initialNavigation]);
  const worktreeCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const {
    snapshot: worktreeState,
    create: handleCreateWorktree,
    remove: handleRemoveWorktree,
  } = useWorktreeState(worktreeCwd);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    syncWorkspaceKey(newProject);
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Selecting an existing session updates the sidebar cwd in a separate
    // effect. That notification can arrive after selectedSession has changed;
    // never interpret the session's own cwd synchronization as a request to
    // close the session and open a blank new-session view.
    if (selectedSession?.cwd === cwd) {
      return;
    }

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (consumeCwdSyncSuppression()) return;
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    leaveWorkspace(cwd);
    clearFilePanel();
    restoreWorkspaceContext(newProject);
    router.replace("/", { scroll: false });
  }, [clearFilePanel, consumeCwdSyncSuppression, leaveWorkspace, restoreWorkspaceContext, router, selectedSession, syncWorkspaceKey]);


  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });


  const handleAgentEnd = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionListRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);
  const requestAgentSessionListRefresh = useSessionListRefreshCoordinator(handleSessionListRefresh);


  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);


  const handleInitialRestoreDone = completeInitialRestore;



  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);


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
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialNavigation.sessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        runningSessionIds={runningSessionIds}
        runningSessionTransitions={runningSessionTransitions}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        worktreeState={worktreeState}
        onCreateWorktree={handleCreateWorktree}
        onRemoveWorktree={handleRemoveWorktree}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onSessionsChange={setSessionCatalog}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = section !== "models" && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
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
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
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
            agentCount: activeSessionFamily?.subagents.length ?? 0,
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
            position={topPanelPos}
            runningSessionIds={runningSessionIds}
            selectedSessionId={selectedSession?.id ?? null}
            session={{
              contextUsage,
              copiedField: copiedSessionField,
              isMobile,
              stats: sessionStats,
            }}
            systemPrompt={systemPrompt}
            systemPromptLoading={systemPromptLoading}
            tools={systemTools}
            toolsLoading={systemToolsLoading}
            translate={translate}
          />


        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
      <ChatWindow
              key={sessionKey}
              session={selectedSession}
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
              onSessionListRefresh={requestAgentSessionListRefresh}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
        onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
        onToolsLoaderChange={handleToolsLoaderChange}
              onShadowMindControlChange={handleShadowMindControlChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
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
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
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
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>

        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {/* Only the active viewer is mounted so inactive tabs do not keep watchers alive. */}
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialState={activeFileTab.viewerState}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              watchEnabled={rightPanelOpen}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
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
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={bumpSessionKey}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={closeProjectTrustDialog}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    </>
  );
}
