"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bot, Bug, Eye, GitBranch, History, ListTree, MoreHorizontal, ScrollText, SlidersHorizontal, Sparkles, Wrench } from "lucide-react";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionTreeNode } from "@/lib/types";
import type { TopPanel } from "@/hooks/useTopPanel";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { ShadowSessionToggle } from "./ShadowSessionToggle";
import { DraftObserverSessionToggle, ObserverSessionToggle } from "./ObserverSessionToggle";
import { SESSION_OBSERVER_FEATURE_ENABLED } from "@/lib/session-observer-protocol";
import { SYSTEM_PROMPT_ADDON_EDITOR_ATTR, SystemPromptAddonToggle } from "./SystemPromptAddonToggle";
import { SessionStatsButton } from "./SessionInfoControls";

// app/globals.css: 42px desktop, 44px on a phone or touch screen.
const NOOP = () => {};
type Translate = (key: string, params?: Record<string, string | number>) => string;
type AutoNameStatus = { kind: "idle" | "naming" | "success" } | { kind: "error"; message: string };

interface AppTopBarProps {
  activePanel: TopPanel | null;
  endAction: ReactNode;
  locale: string;
  navigation: {
    activeLeafId: string | null;
    branchTree: SessionTreeNode[];
    isMobile: boolean;
    onLeafChange: (leafId: string | null) => void;
    onSidebarToggle: () => void;
    sidebarOpen: boolean;
    topBarRef: RefObject<HTMLDivElement | null>;
  };
  onTogglePanel: (panel: TopPanel) => void;
  /** 移动端「大纲」按钮：打开会话大纲的底部抽屉（桌面不经过这里）。 */
  outline: { available: boolean; open: boolean; onToggle: () => void };
  /** 顶栏「工具设置」：扩展工具的模型/思考强度面板。 */
  onOpenToolSettings: () => void;
  session: {
    /** Running subagents while any runs, else all of them; null without subagents. */
    agentsBadge: { count: number; running: boolean } | null;
    autoNameStatus: AutoNameStatus;
    contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    hasPersistedSession: boolean;
    identityKey: string;
    messageCount: number;
    onAutoName: () => void;
    onHistory: () => void;
    onSystemPromptAddonChange?: () => void;
    observerPanel?: { sessionId: string; open: boolean; toggle: () => void };
    observerDraft?: { cwd: string; sessionId: string | null; busy: boolean };
    shadowControl: ShadowSessionControl | null;
    show: boolean;
    stats: SessionStatsInfo | null;
    systemPrompt: string | null;
  };
  translate: Translate;
  trust: { needsTrust: boolean; onOpen: () => void };
}

// While subagents run: their count, ringed by a spinner; otherwise all of them.
function AgentsBadge({ badge }: { badge: { count: number; running: boolean } }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute", top: 3, right: 3,
        minWidth: 13, height: 13, padding: "0 3px", display: "grid", placeItems: "center",
        borderRadius: 7,
        background: badge.running ? "color-mix(in srgb, var(--accent) 22%, var(--bg-panel))" : "var(--bg-selected)",
        color: "var(--accent)",
        fontSize: 9, lineHeight: 1, fontVariantNumeric: "tabular-nums",
        fontWeight: badge.running ? 600 : undefined,
      }}
    >
      {badge.running && (
        <svg
          className="animate-spin motion-reduce:animate-none"
          viewBox="0 0 24 24" fill="none" aria-hidden="true"
          style={{ position: "absolute", top: -3, left: -3, width: "calc(100% + 6px)", height: "calc(100% + 6px)", pointerEvents: "none" }}
        >
          <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" opacity="0.2" />
          <path d="M23 12a11 11 0 0 0-11-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {badge.count}
    </span>
  );
}

function IconButton({ active = false, children, debugButton = false, label, onClick }: { active?: boolean; children: React.ReactNode; debugButton?: boolean; label: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" data-debug-button={debugButton ? "" : undefined} onClick={onClick} title={label} aria-label={label} aria-pressed={active} className={`top-bar-btn top-bar-icon-btn${active ? " is-active" : ""}`}>
      {children}
    </button>
  );
}

function AgentsButton({ activePanel, onTogglePanel, session, translate }: Pick<AppTopBarProps, "activePanel" | "onTogglePanel" | "session" | "translate">) {
  if (!session.agentsBadge) return null;
  return (
    <IconButton
      active={activePanel === "agents"}
      label={session.agentsBadge.running ? translate("agentSwitcher.titleRunning", { count: session.agentsBadge.count }) : translate("agentSwitcher.title")}
      onClick={() => onTogglePanel("agents")}
    >
      <Bot size={15} aria-hidden="true" />
      {session.agentsBadge.count > 0 && <AgentsBadge badge={session.agentsBadge} />}
    </IconButton>
  );
}

function DebugTopBarButton({ activePanel, onTogglePanel, translate, showLabel }: Pick<AppTopBarProps, "activePanel" | "onTogglePanel" | "translate"> & { showLabel?: boolean }) {
  return (
    <IconButton active={activePanel === "debug"} label={translate("debug.title")} onClick={() => onTogglePanel("debug")} debugButton>
      <Bug size={13} aria-hidden="true" />
      {showLabel && translate("debug.title")}
    </IconButton>
  );
}
function ObserverTopBarToggle({ session, compact }: { session: AppTopBarProps["session"]; compact: boolean }) {
  const sessionId = session.observerPanel?.sessionId ?? session.observerDraft?.sessionId;
  if (sessionId) {
    return <ObserverSessionToggle key={sessionId} sessionId={sessionId} compact={compact} showLabel={!session.observerPanel && !compact} />;
  }
  const draft = session.observerDraft;
  return draft ? <DraftObserverSessionToggle cwd={draft.cwd} disabled={draft.busy} compact={compact} /> : null;
}
function SessionTopBarControls({ activePanel, hideAgents = false, hideStats = false, stacked = false, locale, navigation, onOpenToolSettings, onTogglePanel, session, translate }: Pick<AppTopBarProps, "activePanel" | "navigation" | "onOpenToolSettings" | "onTogglePanel" | "session" | "translate"> & { hideAgents?: boolean; hideStats?: boolean; stacked?: boolean; locale: string }) {
  if (!session.show) return null;
  const hasMessages = session.hasPersistedSession && (
    (session.stats?.userMessages ?? 0) > 0
    || (session.stats?.totalMessages ?? 0) > 0
    || session.messageCount > 0
  );
  const naming = session.autoNameStatus.kind === "naming";
  const autoNameDisabled = !hasMessages || naming;
  const autoNameLabel = naming
    ? translate("title.generating")
    : session.autoNameStatus.kind === "success"
      ? translate("title.updated")
      : session.autoNameStatus.kind === "error"
        ? translate("title.failed")
        : translate("title.generate");
  const shadow = session.shadowControl;
  const hasBranches = hasSessionBranches(navigation.branchTree);

  return (
    <>
      <div className={stacked ? "mobile-top-bar-menu-rows" : "top-bar-controls-row"}>
        <button type="button" onClick={session.onHistory} disabled={!session.hasPersistedSession} title={session.hasPersistedSession ? translate("history.full") : translate("history.unsaved")} aria-label={translate("history.label")} className="top-bar-btn top-bar-text-btn">
          {stacked && <History size={16} aria-hidden="true" />}{translate("history.label")}
        </button>
        <button type="button" onClick={session.onAutoName} disabled={autoNameDisabled} title={autoNameLabel} aria-label={autoNameLabel} className="top-bar-btn top-bar-text-btn">
          {stacked && <Sparkles size={16} aria-hidden="true" />}{autoNameLabel}
        </button>
        {!hideAgents && <AgentsButton {...{ activePanel, onTogglePanel, session, translate }} />}
        {hasBranches && (stacked ? (
          <button type="button" onClick={() => onTogglePanel("branches")} aria-pressed={activePanel === "branches"}>
            <GitBranch size={16} aria-hidden="true" />{translate("i18n.branches")}
          </button>
        ) : (
          <BranchNavigator
            tree={navigation.branchTree}
            activeLeafId={navigation.activeLeafId}
            onLeafChange={navigation.onLeafChange}
            inline
            compact={false}
            containerRef={navigation.topBarRef}
            open={activePanel === "branches"}
            onToggle={() => onTogglePanel("branches")}
            hasSession
          />
        ))}
        <button type="button" onClick={() => onTogglePanel("system")} title={translate("system.prompt")} aria-label={translate("system.label")} aria-pressed={activePanel === "system"} className={`top-bar-btn top-bar-text-btn${activePanel === "system" ? " is-active" : ""}${session.systemPrompt ? " has-accent" : ""}`}>
          {stacked && <ScrollText size={16} aria-hidden="true" />}{translate("system.label")}
        </button>
        <button type="button" onClick={() => onTogglePanel("tools")} title={translate("tools.title")} aria-label={translate("tools.title")} aria-pressed={activePanel === "tools"} className={`top-bar-btn top-bar-text-btn${activePanel === "tools" ? " is-active" : ""}`}>
          {stacked && <Wrench size={16} aria-hidden="true" />}{translate("tools.label")}
        </button>
        <button type="button" onClick={onOpenToolSettings} title={translate("tools.settingsTitle")} aria-label={translate("tools.settingsTitle")} className="top-bar-btn top-bar-text-btn">
          {stacked && <SlidersHorizontal size={16} aria-hidden="true" />}{translate("tools.settingsLabel")}
        </button>
        <DebugTopBarButton {...{ activePanel, onTogglePanel, translate }} showLabel={stacked} />
        {!stacked && <span className="top-bar-group-sep" aria-hidden="true" />}
        <ShadowSessionToggle
          enabled={shadow?.enabled ?? true}
          pending={shadow?.pending ?? false}
          available={shadow?.available ?? false}
          onToggle={shadow?.onToggle ?? NOOP}
        />
        <SystemPromptAddonToggle scopeKey={shadow?.scopeKey ?? null} sessionId={shadow?.sessionId ?? null} onChange={session.onSystemPromptAddonChange} />
        {SESSION_OBSERVER_FEATURE_ENABLED && (session.observerPanel || session.observerDraft) && (
          <div className="top-bar-toggle-group">
            {session.observerPanel && (
              <button
                type="button"
                onClick={session.observerPanel.toggle}
                aria-expanded={session.observerPanel.open}
                aria-controls={session.observerPanel.open ? "session-observer-panel" : undefined}
                aria-label={translate("observer.label")}
                title={translate("observer.label")}
                className={`top-bar-toggle-part top-bar-toggle-label${session.observerPanel.open ? " is-active" : ""}`}
              >
                <Eye size={14} aria-hidden="true" />
                {translate("observer.label")}
              </button>
            )}
            <ObserverTopBarToggle session={session} compact={false} />
          </div>
        )}
      </div>
      {!hideStats && (
        <SessionStatsButton
          active={activePanel === "session"}
          contextUsage={session.contextUsage}
          isMobile={navigation.isMobile}
          locale={locale}
          onClick={() => onTogglePanel("session")}
          sessionStats={session.stats}
          translate={translate}
        />
      )}
    </>
  );
}

export function AppTopBar(props: AppTopBarProps) {
  const { activePanel, endAction, locale, navigation, onOpenToolSettings, onTogglePanel, outline, session, translate, trust } = props;
  const mobileMenuId = useId();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const toolbarShellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = toolbarShellRef.current;
      const inAddonEditor = event.target instanceof Element && event.target.closest(`[${SYSTEM_PROMPT_ADDON_EDITOR_ATTR}]`);
      if (toolbar && !inAddonEditor && !event.composedPath().includes(toolbar)) setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target instanceof Element && event.target.closest("dialog, [aria-modal='true']"))) return;
      event.preventDefault();
      setMobileToolbarMoreOpen(false);
      moreButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [navigation.isMobile, session.identityKey]);

  const projectTrustWarning = session.show && trust.needsTrust ? (
    <button
      type="button"
      onClick={trust.onOpen}
      title={translate("trust.resourcesNotLoaded")}
      data-mobile-trust-banner={navigation.isMobile ? "true" : undefined}
      className={navigation.isMobile ? undefined : "top-bar-trust-pill"}
      style={navigation.isMobile ? { height: 30, width: "100%", padding: "0 10px", background: "var(--bg-panel)", border: 0, borderBottom: "1px solid var(--border)", color: "#d97706", cursor: "pointer", textAlign: "left" } : undefined}
    >
      {translate("trust.resourcesNotLoaded")}
    </button>
  ) : null;

  return (
    <div ref={toolbarShellRef} className="app-top-bar-container" style={{ position: "relative", flexShrink: 0, minWidth: 0 }}>
      <div className="app-top-bar-shell" data-mobile-toolbar={navigation.isMobile ? "true" : undefined} style={{ display: "flex", minWidth: 0, height: "var(--top-bar-height)" }}>
        <div ref={navigation.topBarRef} className="app-top-bar">
          <IconButton label={navigation.sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")} onClick={() => { setMobileToolbarMoreOpen(false); navigation.onSidebarToggle(); }}>
            {navigation.sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            )}
          </IconButton>
          {navigation.isMobile ? (
            session.show && (
              <div className="mobile-top-bar-primary">
                <SessionStatsButton
                  active={activePanel === "session"}
                  contextUsage={session.contextUsage}
                  isMobile
                  locale={locale}
                  onClick={() => { setMobileToolbarMoreOpen(false); onTogglePanel("session"); }}
                  sessionStats={session.stats}
                  translate={translate}
                />
                <AgentsButton {...{ activePanel, session, translate }} onTogglePanel={(panel) => { setMobileToolbarMoreOpen(false); onTogglePanel(panel); }} />
                {outline.available && (
                  <button
                    type="button"
                    className="mobile-top-bar-outline"
                    data-mobile-outline-button=""
                    aria-pressed={outline.open}
                    title={translate("chatMinimap.mobileOpen")}
                    aria-label={translate("chatMinimap.mobileOpen")}
                    onClick={() => { setMobileToolbarMoreOpen(false); outline.onToggle(); }}
                  >
                    <ListTree size={18} aria-hidden="true" />
                  </button>
                )}
                <button
                  ref={moreButtonRef}
                  type="button"
                  className="mobile-top-bar-more"
                  aria-expanded={mobileToolbarMoreOpen}
                  aria-controls={mobileToolbarMoreOpen ? mobileMenuId : undefined}
                  onClick={() => setMobileToolbarMoreOpen((open) => !open)}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
                  {translate("chat.mobileMore")}
                </button>
              </div>
            )
          ) : (
            <>
              {(session.show || projectTrustWarning) && <span className="top-bar-group-sep" aria-hidden="true" />}
              {projectTrustWarning}
              <SessionTopBarControls {...{ activePanel, navigation, onOpenToolSettings, onTogglePanel, session, translate, locale }} />
            </>
          )}
        </div>
        <div className="app-top-bar-end" onClick={() => setMobileToolbarMoreOpen(false)}>
          {endAction}
        </div>
      </div>
      {navigation.isMobile && projectTrustWarning}
      {navigation.isMobile && activePanel === "branches" && hasSessionBranches(navigation.branchTree) && (
        <BranchNavigator
          tree={navigation.branchTree}
          activeLeafId={navigation.activeLeafId}
          onLeafChange={navigation.onLeafChange}
          containerRef={navigation.topBarRef}
          inline
          hideInlineButton
          open
          hasSession
        />
      )}
      {navigation.isMobile && session.show && mobileToolbarMoreOpen && (
        <div id={mobileMenuId} className="mobile-top-bar-menu" aria-label={translate("chat.moreControls")} role="region">
          <SessionTopBarControls
            {...{ activePanel, navigation, translate, locale }}
            onOpenToolSettings={() => { setMobileToolbarMoreOpen(false); onOpenToolSettings(); }}
            stacked
            hideAgents
            hideStats
            onTogglePanel={(panel) => { setMobileToolbarMoreOpen(false); onTogglePanel(panel); }}
            session={{
              ...session,
              onHistory: () => { setMobileToolbarMoreOpen(false); session.onHistory(); },
              observerPanel: session.observerPanel && {
                ...session.observerPanel,
                toggle: () => { setMobileToolbarMoreOpen(false); session.observerPanel?.toggle(); },
              },
            }}
          />
        </div>
      )}
    </div>
  );
}
