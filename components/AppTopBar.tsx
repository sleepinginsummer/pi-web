"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bot, History, MoreHorizontal, ScrollText, Sparkles, Wrench, X } from "lucide-react";
import { useIsNarrowMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionTreeNode } from "@/lib/types";
import type { TopPanel } from "@/hooks/useTopPanel";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { ShadowSessionToggle } from "./ShadowSessionToggle";
import { SessionStatsButton } from "./SessionInfoControls";

const ICON_BUTTON_SIZE = 36;
const NOOP = () => {};
type Translate = (key: string) => string;
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
  session: {
    agentCount: number;
    autoNameStatus: AutoNameStatus;
    contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    hasPersistedSession: boolean;
    identityKey: string;
    messageCount: number;
    onAutoName: () => void;
    onHistory: () => void;
    shadowControl: ShadowSessionControl | null;
    show: boolean;
    stats: SessionStatsInfo | null;
    systemPrompt: string | null;
  };
  translate: Translate;
  trust: { needsTrust: boolean; onOpen: () => void };
}

function IconButton({ active = false, children, label, onClick }: { active?: boolean; children: React.ReactNode; label: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={active} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE, padding: 0, fontFamily: "inherit", fontSize: "inherit", lineHeight: 1, background: active ? "var(--bg-selected)" : "none", border: "none", borderRight: "1px solid var(--border)", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}>
      {children}
    </button>
  );
}

function SessionTopBarControls({ activePanel, hideShadow = false, hideStats = false, locale, navigation, onTogglePanel, session, translate }: Pick<AppTopBarProps, "activePanel" | "navigation" | "onTogglePanel" | "session" | "translate"> & { hideShadow?: boolean; hideStats?: boolean; locale: string }) {
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
      <div style={{ display: "flex", alignItems: "stretch", height: "100%", flexShrink: 0 }}>
        <button type="button" onClick={session.onHistory} disabled={!session.hasPersistedSession} title={session.hasPersistedSession ? translate("history.full") : translate("history.unsaved")} aria-label={translate("history.label")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: navigation.isMobile ? ICON_BUTTON_SIZE : undefined, height: "100%", padding: navigation.isMobile ? 0 : "0 12px", background: "none", border: 0, borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: session.hasPersistedSession ? "pointer" : "not-allowed" }}>
          {navigation.isMobile ? <History size={15} aria-hidden="true" /> : translate("history.label")}
        </button>
        <button type="button" onClick={session.onAutoName} disabled={autoNameDisabled} title={autoNameLabel} aria-label={autoNameLabel} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: navigation.isMobile ? ICON_BUTTON_SIZE : undefined, height: "100%", padding: navigation.isMobile ? 0 : "0 12px", background: "none", border: 0, borderRight: "1px solid var(--border)", color: autoNameDisabled ? "var(--text-dim)" : "var(--text-muted)", cursor: autoNameDisabled ? "not-allowed" : "pointer" }}>
          {navigation.isMobile ? <Sparkles size={15} aria-hidden="true" /> : autoNameLabel}
        </button>
        {session.agentCount > 0 && (
          <IconButton active={activePanel === "agents"} label={translate("agentSwitcher.title")} onClick={() => onTogglePanel("agents")}>
            <Bot size={15} aria-hidden="true" />
          </IconButton>
        )}
        {hasBranches && (
          <BranchNavigator
            tree={navigation.branchTree}
            activeLeafId={navigation.activeLeafId}
            onLeafChange={navigation.onLeafChange}
            inline
            compact={navigation.isMobile}
            containerRef={navigation.topBarRef}
            open={activePanel === "branches"}
            onToggle={() => onTogglePanel("branches")}
            hasSession
          />
        )}
        <button type="button" onClick={() => onTogglePanel("system")} title={translate("system.prompt")} aria-label={translate("system.label")} aria-pressed={activePanel === "system"} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: navigation.isMobile ? ICON_BUTTON_SIZE : undefined, height: "100%", padding: navigation.isMobile ? 0 : "0 12px", background: activePanel === "system" ? "var(--bg-selected)" : "none", border: 0, borderRight: "1px solid var(--border)", color: session.systemPrompt ? "var(--accent)" : "var(--text-muted)", cursor: "pointer" }}>
          {navigation.isMobile ? <ScrollText size={15} aria-hidden="true" /> : translate("system.label")}
        </button>
        <button type="button" onClick={() => onTogglePanel("tools")} title={translate("tools.title")} aria-label={translate("tools.title")} aria-pressed={activePanel === "tools"} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: navigation.isMobile ? ICON_BUTTON_SIZE : undefined, height: "100%", padding: navigation.isMobile ? 0 : "0 12px", background: activePanel === "tools" ? "var(--bg-selected)" : "none", border: 0, borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer" }}>
          {navigation.isMobile ? <Wrench size={15} aria-hidden="true" /> : translate("tools.label")}
        </button>
        {!hideShadow && (
          <ShadowSessionToggle
            enabled={shadow?.enabled ?? true}
            pending={shadow?.pending ?? false}
            available={shadow?.available ?? false}
            onToggle={shadow?.onToggle ?? NOOP}
            compact={navigation.isMobile}
          />
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
  const { activePanel, endAction, locale, navigation, onTogglePanel, session, translate, trust } = props;
  const isNarrowMobile = useIsNarrowMobile();
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const toolbarShellRef = useRef<HTMLDivElement>(null);
  const shadow = session.shadowControl;

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = toolbarShellRef.current;
      if (toolbar && !event.composedPath().includes(toolbar)) setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileToolbarMoreOpen(false);
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
  }, [isNarrowMobile, navigation.isMobile, session.identityKey]);

  const projectTrustWarning = session.show && trust.needsTrust ? (
    <button
      type="button"
      onClick={trust.onOpen}
      title={translate("trust.resourcesNotLoaded")}
      data-mobile-trust-banner={navigation.isMobile ? "true" : undefined}
      style={{ height: navigation.isMobile ? 30 : "100%", width: navigation.isMobile ? "100%" : undefined, padding: navigation.isMobile ? "0 10px" : "0 12px", background: "var(--bg-panel)", border: 0, borderBottom: navigation.isMobile ? "1px solid var(--border)" : undefined, borderRight: navigation.isMobile ? undefined : "1px solid var(--border)", color: "#d97706", cursor: "pointer", textAlign: navigation.isMobile ? "left" : "center" }}
    >
      {translate("trust.resourcesNotLoaded")}
    </button>
  ) : null;

  return (
    <div ref={toolbarShellRef} className="app-top-bar-container" style={{ position: "relative", flexShrink: 0, minWidth: 0 }}>
      <div className="app-top-bar-shell" data-mobile-toolbar={navigation.isMobile ? "true" : undefined} style={{ display: "flex", minWidth: 0, height: 36 }}>
        <div ref={navigation.topBarRef} className="app-top-bar" style={{ position: "relative", display: "flex", flex: "1 1 auto", alignItems: "center", minWidth: 0, overflowX: navigation.isMobile && !isNarrowMobile ? "auto" : "hidden", overflowY: "hidden", overscrollBehaviorInline: "contain", scrollbarWidth: "none", touchAction: navigation.isMobile && !isNarrowMobile ? "pan-x" : "auto", borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)", fontFamily: "inherit", fontSize: 11, fontWeight: 400, lineHeight: 1 }}>
          <IconButton label={navigation.sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")} onClick={navigation.onSidebarToggle}>
            {navigation.sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            )}
          </IconButton>
          {navigation.isMobile && isNarrowMobile ? (
            <>
              {session.show && (
                <ShadowSessionToggle
                  enabled={shadow?.enabled ?? true}
                  pending={shadow?.pending ?? false}
                  available={shadow?.available ?? false}
                  onToggle={shadow?.onToggle ?? NOOP}
                  compact
                />
              )}
              <div style={{ position: "relative", display: "flex", flex: "1 1 auto", alignItems: "stretch", minWidth: 0, height: "100%" }}>
                {!mobileToolbarMoreOpen && (
                  <>
                    {session.show && (
                      <SessionStatsButton
                        active={activePanel === "session"}
                        contextUsage={session.contextUsage}
                        isMobile
                        locale={locale}
                        onClick={() => onTogglePanel("session")}
                        sessionStats={session.stats}
                        translate={translate}
                      />
                    )}
                    <IconButton label={translate("chat.moreControls")} onClick={() => setMobileToolbarMoreOpen(true)}>
                      <MoreHorizontal size={17} aria-hidden="true" />
                    </IconButton>
                  </>
                )}
                {mobileToolbarMoreOpen && (
                  <div data-mobile-toolbar-actions="true" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "stretch", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", background: "var(--bg-panel)", zIndex: 1 }}>
                    <SessionTopBarControls
                      {...{ activePanel, navigation, onTogglePanel, session, translate }}
                      hideShadow
                      hideStats
                      locale={locale}
                    />
                    <IconButton label={translate("chat.close")} onClick={() => setMobileToolbarMoreOpen(false)}>
                      <X size={16} aria-hidden="true" />
                    </IconButton>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {!navigation.isMobile && projectTrustWarning}
              <SessionTopBarControls
                {...{ activePanel, navigation, onTogglePanel, session, translate }}
                locale={locale}
              />
            </>
          )}
        </div>
        <div className="app-top-bar-end" aria-hidden={mobileToolbarMoreOpen ? true : undefined} style={{ display: "flex", flex: "0 0 auto", visibility: mobileToolbarMoreOpen ? "hidden" : "visible", pointerEvents: mobileToolbarMoreOpen ? "none" : "auto" }}>
          {endAction}
        </div>
      </div>
      {navigation.isMobile && projectTrustWarning}
    </div>
  );
}
