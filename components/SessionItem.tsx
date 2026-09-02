"use client";

import { Pin as PinIcon } from "lucide-react";
import { useCallback, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSessionItemMutations } from "@/hooks/useSessionItemMutations";
import { useSwipeActions } from "@/hooks/useSwipeActions";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { parseSkillMessage } from "@/lib/skill-block";
import type { SessionInfo } from "@/lib/types";

const ITEM_HEIGHT = 54;
const SESSION_SWIPE_ACTION_WIDTH = 132;

type ActionTone = "pin" | "accent" | "danger";

interface SessionItemStatus {
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  isPinned?: boolean;
}

interface SessionItemMobileState {
  enabled: boolean;
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
}

interface SessionItemActions {
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onTogglePinned?: () => void;
}

interface SessionItemTreeState {
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface SessionItemProps {
  session: SessionInfo;
  status: SessionItemStatus;
  mobile: SessionItemMobileState;
  actions: SessionItemActions;
  tree?: SessionItemTreeState;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function RenameIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>;
}

function DeleteIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function SessionActionButton({ mobile, open, label, pressed, tone, onClick, children }: {
  mobile: boolean;
  open: boolean;
  label: string;
  pressed?: boolean;
  tone: ActionTone;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  const color = tone === "danger" ? "#ef4444" : tone === "accent" ? "var(--accent)" : pressed ? "#d97706" : "var(--text-muted)";
  const background = tone === "danger" && mobile ? "rgba(239,68,68,0.10)" : pressed ? "color-mix(in srgb, #f59e0b 12%, var(--bg-hover))" : "var(--bg-hover)";
  return (
    <button
      type="button"
      tabIndex={mobile && !open ? -1 : 0}
      title={label}
      aria-label={label}
      aria-pressed={tone === "pin" ? pressed : undefined}
      onClick={onClick}
      style={{ width: mobile ? 44 : 32, height: mobile ? ITEM_HEIGHT : 32, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0, border: mobile ? "none" : `1px solid ${pressed ? "rgba(217,119,6,0.42)" : "var(--border)"}`, borderLeft: mobile ? "1px solid var(--border)" : undefined, borderRadius: mobile ? 0 : 7, background, color, cursor: "pointer", touchAction: "manipulation", transition: "background 0.12s, color 0.12s, border-color 0.12s" }}
    >
      {children}
    </button>
  );
}

function SessionActions({ mobile, open, isPinned, onTogglePinned, onRename, onDelete }: {
  mobile: boolean;
  open: boolean;
  isPinned: boolean;
  onTogglePinned: (event: MouseEvent<HTMLButtonElement>) => void;
  onRename: (event: MouseEvent<HTMLButtonElement>) => void;
  onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  const containerStyle = mobile
    ? { position: "absolute" as const, inset: "0 0 0 auto", width: SESSION_SWIPE_ACTION_WIDTH, height: ITEM_HEIGHT, display: "flex", zIndex: 0 }
    : { display: "flex", gap: 4, flexShrink: 0 };
  return (
    <div aria-hidden={mobile && !open} style={containerStyle}>
      <SessionActionButton mobile={mobile} open={open} label={t(isPinned ? "sidebar.unpin" : "sidebar.pin")} pressed={isPinned} tone="pin" onClick={onTogglePinned}>
        <PinIcon size={mobile ? 17 : 14} strokeWidth={2} aria-hidden="true" style={{ transform: "rotate(45deg)" }} />
      </SessionActionButton>
      <SessionActionButton mobile={mobile} open={open} label={t("sidebar.rename")} tone="accent" onClick={onRename}><RenameIcon size={mobile ? 17 : 14} /></SessionActionButton>
      <SessionActionButton mobile={mobile} open={open} label={mobile ? t("sidebar.delete") : t("sidebar.deleteWithShiftClick")} tone="danger" onClick={onDelete}><DeleteIcon size={mobile ? 17 : 14} /></SessionActionButton>
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span title={t("sidebar.agentRunning")} aria-label={t("sidebar.agentRunning")} style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--accent)" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g><path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" /><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" /></g></svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span title={t("sidebar.newActivity")} aria-label={t("sidebar.newSessionActivity")} style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#0891b2" }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="2.5" fill="currentColor" /><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" opacity="0.28" /></svg>
    </span>
  );
}

function SessionDeleteConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const shortTitle = title.slice(0, 22) + (title.length > 22 ? "…" : "");
  return (
    <>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebar.deleteSession", { title: shortTitle })}</div>
      <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
        <button type="button" onClick={(event) => { event.stopPropagation(); onConfirm(); }} style={{ height: 30, padding: "0 11px", background: "#ef4444", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, fontWeight: 600 }}>{t("sidebar.delete")}</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); onCancel(); }} style={{ height: 30, padding: "0 11px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontSize: 12, fontWeight: 500 }}>{t("sidebar.cancel")}</button>
      </div>
    </>
  );
}

function SessionRenameInput({ inputRef, value, onChange, onCommit, onCancel }: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit();
        if (event.key === "Escape") onCancel();
      }}
      autoFocus
      style={{ flex: 1, height: 30, padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
    />
  );
}

function SessionRowContent({ session, view, actions }: {
  session: SessionInfo;
  view: {
    title: string;
    status: Required<Pick<SessionItemStatus, "isSelected" | "isPinned">> & Pick<SessionItemStatus, "isRunning" | "isUnread">;
    isMobile: boolean;
    hovered: boolean;
    tree: Required<Pick<SessionItemTreeState, "depth" | "hasChildren" | "collapsed">>;
  };
  actions: {
    onToggleCollapse?: () => void;
    onTogglePinned: (event: MouseEvent<HTMLButtonElement>) => void;
    onRename: (event: MouseEvent<HTMLButtonElement>) => void;
    onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
  };
}) {
  const { title, status, isMobile, hovered, tree } = view;
  const { isSelected, isRunning, isUnread, isPinned } = status;
  const { depth, hasChildren, collapsed } = tree;
  const { onToggleCollapse, onTogglePinned, onRename, onDelete } = actions;
  const { t } = useI18n();
  return (
    <>
      {depth > 0 && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div title={title} style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, color: "var(--text)", fontSize: 12, fontWeight: isSelected ? 500 : 400, lineHeight: 1.4 }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{title}</span></div>
        <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
          {isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : <span title={session.modified}>{formatRelativeTime(session.modified)}</span>}
          <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
          {session.currentBranch && (
            <span title={`${session.isWorktree ? "Worktree" : "当前分支"}: ${session.currentBranch}\n${session.cwd}`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.currentBranch}</span>
            </span>
          )}
        </div>
      </div>
      {hasChildren && (
        <button type="button" onClick={(event) => { event.stopPropagation(); onToggleCollapse?.(); }} title={collapsed ? "Expand forks" : "Collapse forks"} style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0, background: "none", border: "none", color: "var(--text-dim)", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="2 3.5 5 6.5 8 3.5" /></svg></button>
      )}
      {!isMobile && (hovered || isSelected) && <SessionActions mobile={false} open isPinned={isPinned} onTogglePinned={onTogglePinned} onRename={onRename} onDelete={onDelete} />}
    </>
  );
}

export function SessionItem({ session, status, mobile, actions, tree = {} }: SessionItemProps) {
  const { isSelected, isRunning, isUnread, isPinned = false } = status;
  const { enabled: isMobile, swipeOpen, onSwipeOpenChange } = mobile;
  const { onClick, onRenamed, onDeleted, onTogglePinned } = actions;
  const { depth = 0, hasChildren = false, collapsed = false, onToggleCollapse } = tree;
  const [hovered, setHovered] = useState(false);
  const displayFirstMessage = parseSkillMessage(session.firstMessage)?.displayText ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
  const mutations = useSessionItemMutations({ session, title, onRenamed, onDeleted, onSwipeOpenChange });
  const swipe = useSwipeActions({ enabled: isMobile && !mutations.renaming && !mutations.confirmDelete, open: swipeOpen, actionWidth: SESSION_SWIPE_ACTION_WIDTH, onOpenChange: onSwipeOpenChange });

  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({ id: session.id, path: session.path, cwd: session.cwd, name: session.name, clientX: event.clientX, clientY: event.clientY, refresh: () => onRenamed?.() });
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  const handleRowClick = useCallback(() => {
    if (mutations.confirmDelete || mutations.renaming || swipe.consumeClick()) return;
    onClick();
  }, [mutations.confirmDelete, mutations.renaming, onClick, swipe]);

  const stopAndTogglePin = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSwipeOpenChange(false);
    onTogglePinned?.();
  };
  const stopAndRename = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    mutations.beginRename();
  };
  const stopAndDelete = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    mutations.requestDelete(!isMobile && event.shiftKey);
  };

  return (
    <div style={{ height: ITEM_HEIGHT, position: "relative", overflow: "hidden" }}>
      {isMobile && !mutations.confirmDelete && !mutations.renaming && <SessionActions mobile open={swipeOpen} isPinned={isPinned} onTogglePinned={stopAndTogglePin} onRename={stopAndRename} onDelete={stopAndDelete} />}
      <div
        {...swipe.pointerHandlers}
        onClick={handleRowClick}
        onContextMenu={isMobile || mutations.confirmDelete || mutations.renaming ? undefined : handleContextMenu}
        onMouseEnter={() => { if (!isMobile) setHovered(true); }}
        onMouseLeave={() => { if (!isMobile) setHovered(false); }}
        style={{ width: "100%", height: ITEM_HEIGHT, boxSizing: "border-box", display: "flex", position: "relative", zIndex: 1, alignItems: "center", paddingLeft: depth > 0 ? depth * 12 + 14 : 14, paddingRight: isPinned ? 32 : 8, cursor: mutations.confirmDelete || mutations.renaming ? "default" : "pointer", background: mutations.confirmDelete ? "rgba(239,68,68,0.06)" : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : isMobile ? "var(--bg-panel)" : "transparent", borderLeft: mutations.confirmDelete ? "2px solid #ef4444" : isSelected ? "2px solid var(--accent)" : "2px solid transparent", transform: isMobile ? `translateX(${swipe.offset}px)` : "none", transition: swipe.dragging ? "none" : "background 0.1s, transform 0.18s ease-out", touchAction: isMobile ? "pan-y" : "auto", willChange: isMobile ? "transform" : "auto", opacity: mutations.deleting ? 0.5 : 1, gap: 6, overflow: "hidden" }}
      >
        {isPinned && <span aria-hidden="true" style={{ position: "absolute", top: 0, right: 0, width: 24, height: 16, display: "flex", alignItems: "center", justifyContent: "center", background: "#eab308", borderBottomLeftRadius: 5, color: "#713f12", boxShadow: "0 1px 2px rgba(161,98,7,0.24)", pointerEvents: "none", zIndex: 1 }}><PinIcon size={12} strokeWidth={2.4} aria-hidden="true" style={{ transform: "rotate(45deg)" }} /></span>}
        {mutations.confirmDelete ? (
          <SessionDeleteConfirm title={title} onConfirm={() => void mutations.performDelete()} onCancel={mutations.cancelDelete} />
        ) : mutations.renaming ? (
          <SessionRenameInput inputRef={mutations.renameInputRef} value={mutations.renameValue} onChange={mutations.setRenameValue} onCommit={() => void mutations.commitRename()} onCancel={mutations.cancelRename} />
        ) : (
          <SessionRowContent
            session={session}
            view={{
              title,
              status: { isSelected, isRunning, isUnread, isPinned },
              isMobile,
              hovered,
              tree: { depth, hasChildren, collapsed },
            }}
            actions={{ onToggleCollapse, onTogglePinned: stopAndTogglePin, onRename: stopAndRename, onDelete: stopAndDelete }}
          />
        )}
      </div>
    </div>
  );
}
