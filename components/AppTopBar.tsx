"use client";

import type { RefObject } from "react";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionTreeNode } from "@/lib/types";
import type { TopPanel } from "@/hooks/useTopPanel";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";
import { BranchNavigator } from "./BranchNavigator";
import { ShadowSessionToggle } from "./ShadowSessionToggle";
import { SessionStatsButton } from "./SessionInfoControls";

const ICON_BUTTON_SIZE = 36;
const NOOP = () => {};
type Translate = (key: string) => string;
type AutoNameStatus = { kind: "idle" | "naming" | "success" } | { kind: "error"; message: string };

interface AppTopBarProps {
  activePanel: TopPanel | null;
  appearance: {
    isDark: boolean;
    languageButtonRef: RefObject<HTMLButtonElement | null>;
    locale: string;
    toggleTheme: (origin?: { x: number; y: number }) => void;
  };
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
    autoNameStatus: AutoNameStatus;
    contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    hasPersistedSession: boolean;
    messageCount: number;
    onAutoName: () => void;
    onHistory: () => void;
    rightPanelOpen: boolean;
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
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={active} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE, padding: 0, background: active ? "var(--bg-selected)" : "none", border: "none", borderRight: "1px solid var(--border)", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}>
      {children}
    </button>
  );
}

function AppearanceControls({ activePanel, appearance, onTogglePanel, translate }: Pick<AppTopBarProps, "activePanel" | "appearance" | "onTogglePanel" | "translate">) {
  return (
    <>
      <IconButton
        label={appearance.isDark ? translate("theme.light") : translate("theme.dark")}
        active={appearance.isDark}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          appearance.toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}
      >
        {appearance.isDark ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M1 12h2M21 12h2" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </IconButton>
      <button
        ref={appearance.languageButtonRef}
        type="button"
        onClick={() => onTogglePanel("language")}
        title={translate("common.language")}
        aria-label={translate("common.language")}
        aria-expanded={activePanel === "language"}
        style={{ width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE, border: 0, borderRight: "1px solid var(--border)", background: activePanel === "language" ? "var(--bg-selected)" : "none", color: "var(--text-muted)", cursor: "pointer" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M22 22l-5-10-5 10M14 18h6" />
        </svg>
      </button>
    </>
  );
}

function SessionTopBarControls({ activePanel, locale, navigation, onTogglePanel, session, translate }: Pick<AppTopBarProps, "activePanel" | "navigation" | "onTogglePanel" | "session" | "translate"> & { locale: string }) {
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

  return (
    <>
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button type="button" onClick={session.onHistory} disabled={!session.hasPersistedSession} title={session.hasPersistedSession ? translate("history.full") : translate("history.unsaved")} style={{ height: "100%", padding: "0 12px", background: "none", border: 0, borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: session.hasPersistedSession ? "pointer" : "not-allowed" }}>
          {!navigation.isMobile && translate("history.label")}
        </button>
        <button type="button" onClick={session.onAutoName} disabled={autoNameDisabled} title={autoNameLabel} style={{ height: "100%", padding: "0 12px", background: "none", border: 0, borderRight: "1px solid var(--border)", color: autoNameDisabled ? "var(--text-dim)" : "var(--text-muted)", cursor: autoNameDisabled ? "not-allowed" : "pointer" }}>
          {!navigation.isMobile && autoNameLabel}
        </button>
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
        <button type="button" onClick={() => onTogglePanel("system")} title={translate("system.prompt")} aria-pressed={activePanel === "system"} style={{ height: "100%", padding: "0 12px", background: activePanel === "system" ? "var(--bg-selected)" : "none", border: 0, borderRight: "1px solid var(--border)", color: session.systemPrompt ? "var(--accent)" : "var(--text-muted)", cursor: "pointer" }}>
          {!navigation.isMobile && translate("system.label")}
        </button>
        <ShadowSessionToggle
          enabled={shadow?.enabled ?? true}
          pending={shadow?.pending ?? false}
          available={shadow?.available ?? false}
          onToggle={shadow?.onToggle ?? NOOP}
          compact={navigation.isMobile}
        />
      </div>
      <SessionStatsButton
        active={activePanel === "session"}
        contextUsage={session.contextUsage}
        isMobile={navigation.isMobile}
        locale={locale}
        onClick={() => onTogglePanel("session")}
        rightPanelOpen={session.rightPanelOpen}
        sessionStats={session.stats}
        translate={translate}
      />
    </>
  );
}

export function AppTopBar(props: AppTopBarProps) {
  const { activePanel, appearance, navigation, onTogglePanel, session, translate, trust } = props;
  return (
    <div ref={navigation.topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
      <IconButton label={navigation.sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")} onClick={navigation.onSidebarToggle}>
        {navigation.sidebarOpen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        )}
      </IconButton>
      <AppearanceControls {...{ activePanel, appearance, onTogglePanel, translate }} />
      {session.show && trust.needsTrust && (
        <button type="button" onClick={trust.onOpen} title={translate("trust.resourcesNotLoaded")} style={{ height: "100%", padding: navigation.isMobile ? "0 10px" : "0 12px", background: "none", border: 0, borderRight: "1px solid var(--border)", color: "#d97706", cursor: "pointer" }}>
          {navigation.isMobile ? "!" : translate("trust.resourcesNotLoaded")}
        </button>
      )}
      <SessionTopBarControls
        {...{ activePanel, navigation, onTogglePanel, session, translate }}
        locale={appearance.locale}
      />
    </div>
  );
}
