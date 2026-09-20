"use client";

import { Pin as PinIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { SessionItem } from "./SessionItem";

interface WorktreeOption {
  path: string;
  label: string;
}

interface ProjectSectionProps {
  project: {
    path: string;
    name: string;
    active: boolean;
    collapsed: boolean;
    pinned: boolean;
    isMobile: boolean;
    activity?: ReactNode;
    sessions: SessionInfo[];
    sessionOrder: string[];
  };
  labels: {
    empty: string;
    pin: string;
    remove: string;
    newSession: string;
  };
  actions: {
    onToggleCollapsed: () => void;
    onMove: (source: string, target: string) => void;
    onTogglePinned: () => void;
    onRemove: () => void;
    onNewSession: () => void;
  };
  treeProps: SessionTreeSharedProps;
  worktree?: {
    ariaLabel: string;
    currentPath: string;
    title?: string;
    options: WorktreeOption[];
    onChange: (path: string) => void;
  };
}

const PROJECT_DRAG_TYPE = "application/x-pi-project";

/** 单个项目目录的条件编排；数据持久化由父层负责。 */
export function ProjectSection({ project, labels, actions, treeProps, worktree }: ProjectSectionProps) {
  const tree = useMemo(() => buildSessionTree(project.sessions, project.sessionOrder), [project.sessionOrder, project.sessions]);
  return (
    <section style={{ padding: "2px 6px 6px" }}>
      <ProjectHeader project={project} labels={labels} actions={actions} />
      {project.active && !project.collapsed && worktree && <WorktreeSelector worktree={worktree} />}
      {!project.collapsed && (
        <div style={{ paddingLeft: 24 }}>
          {tree.length > 0 ? <VirtualizedSessionTree tree={tree} treeProps={treeProps} /> : (
            <div style={{ padding: "5px 10px 7px", color: "var(--text-dim)", fontSize: 11 }}>{labels.empty}</div>
          )}
        </div>
      )}
    </section>
  );
}

function ProjectHeader({
  project,
  labels,
  actions,
}: Pick<ProjectSectionProps, "project" | "labels" | "actions">) {
  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.path);
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) event.preventDefault();
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const source = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    if (!source) return;
    event.preventDefault();
    actions.onMove(source, project.path);
  };

  return (
    <div
      draggable={!project.isMobile}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: 34,
        borderRadius: 6,
        background: project.active ? "var(--bg-hover)" : "transparent",
        cursor: project.isMobile ? "default" : "grab",
      }}
    >
      <button
        type="button"
        onClick={actions.onToggleCollapsed}
        title={project.path}
        aria-expanded={!project.collapsed}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          flex: 1,
          minWidth: 0,
          height: 34,
          padding: "0 4px 0 7px",
          border: 0,
          background: "transparent",
          color: project.active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: project.collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s", flexShrink: 0 }}>
          <polyline points="3 2 7 5 3 8" />
        </svg>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M2.5 5.5h5l1.7 2h8.3v7.5a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5.5Z" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 }}>{project.name}</span>
        {project.activity}
      </button>
      <button
        type="button"
        onClick={actions.onTogglePinned}
        title={labels.pin}
        aria-label={labels.pin}
        aria-pressed={project.pinned}
        style={{ width: 28, height: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 5, background: project.pinned ? "color-mix(in srgb, #f59e0b 12%, transparent)" : "transparent", color: project.pinned ? "#d97706" : "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
      >
        <PinIcon size={13} strokeWidth={2.2} aria-hidden="true" style={{ transform: "rotate(45deg)" }} />
      </button>
      <button
        type="button"
        onClick={actions.onRemove}
        title={labels.remove}
        aria-label={labels.remove}
        style={{ width: 28, height: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={actions.onNewSession}
        title={labels.newSession}
        aria-label={labels.newSession}
        style={{ width: 28, height: 28, padding: 0, marginRight: 3, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <line x1="6" y1="1" x2="6" y2="11" />
          <line x1="1" y1="6" x2="11" y2="6" />
        </svg>
      </button>
    </div>
  );
}

function WorktreeSelector({ worktree }: { worktree: NonNullable<ProjectSectionProps["worktree"]> }) {
  return (
    <label title={worktree.title} style={{ display: "flex", alignItems: "center", gap: 6, height: 28, margin: "0 6px 2px 30px", color: "var(--text-dim)" }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
      <select
        aria-label={worktree.ariaLabel}
        value={worktree.currentPath}
        onChange={(event) => worktree.onChange(event.target.value)}
        style={{ minWidth: 0, flex: 1, height: 26, padding: "0 24px 0 0", border: 0, outline: 0, background: "transparent", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer" }}
      >
        {worktree.options.map((option) => (
          <option key={option.path} value={option.path}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export interface SessionTreeSharedProps {
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  unreadSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  isMobile: boolean;
  openSwipeSessionId: string | null;
  onOpenSwipeSessionChange: (sessionId: string, open: boolean) => void;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onMoveSession: (sourceId: string, targetId: string) => void;
  onTogglePinned: (sessionId: string) => void;
  onSessionDeleted?: (id: string) => void;
}

function buildSessionTree(sessions: SessionInfo[], manualOrder: string[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const session of sessions) byId.set(session.id, { session, children: [] });
  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    if (session.parentSessionId) parentOf.set(session.id, session.parentSessionId);
  }
  const resolveAncestor = (id: string): string | null => {
    let current = parentOf.get(id);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) return null;
      visited.add(current);
      if (byId.has(current)) return current;
      current = parentOf.get(current);
    }
    return null;
  };
  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) byId.get(ancestor)!.children.push(node);
    else roots.push(node);
  }
  const orderIndex = new Map(manualOrder.map((id, index) => [id, index]));
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((left, right) => (orderIndex.get(left.session.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.session.id) ?? Number.MAX_SAFE_INTEGER));
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

const SESSION_TREE_ROW_HEIGHT = 54;
const SESSION_TREE_OVERSCAN = 6;

interface FlatSessionTreeRow {
  node: SessionTreeNode;
  depth: number;
}

function flattenSessionTree(nodes: SessionTreeNode[], collapsedIds: ReadonlySet<string>, depth = 0): FlatSessionTreeRow[] {
  const rows: FlatSessionTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children.length > 0 && !collapsedIds.has(node.session.id)) {
      rows.push(...flattenSessionTree(node.children, collapsedIds, depth + 1));
    }
  }
  return rows;
}

function VirtualizedSessionTree({ tree, treeProps }: { tree: SessionTreeNode[]; treeProps: SessionTreeSharedProps }) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flattenSessionTree(tree, collapsedIds), [collapsedIds, tree]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(rows.length, 30) });

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const scroll = wrapper?.closest<HTMLElement>("[data-session-scroll]");
    if (!wrapper || !scroll) return;
    const update = () => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const clampIndex = (index: number) => Math.min(rows.length, Math.max(0, index));
      const first = clampIndex(Math.floor((scrollRect.top - wrapperRect.top) / SESSION_TREE_ROW_HEIGHT) - SESSION_TREE_OVERSCAN);
      const last = clampIndex(Math.ceil((scrollRect.bottom - wrapperRect.top) / SESSION_TREE_ROW_HEIGHT) + SESSION_TREE_OVERSCAN);
      setRange({ start: first, end: Math.max(first, last) });
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [rows, treeProps.selectedSessionId]);

  const mountedRows = useMemo(() => {
    const visible = rows.slice(range.start, range.end).map((row, offset) => ({ row, index: range.start + offset }));
    const selectedIndex = rows.findIndex((row) => row.node.session.id === treeProps.selectedSessionId);
    if (selectedIndex >= 0 && (selectedIndex < range.start || selectedIndex >= range.end)) {
      visible.push({ row: rows[selectedIndex], index: selectedIndex });
    }
    return visible;
  }, [range.end, range.start, rows, treeProps.selectedSessionId]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", height: rows.length * SESSION_TREE_ROW_HEIGHT }}>
      {mountedRows.map(({ row: { node, depth }, index }) => {
        const collapsed = collapsedIds.has(node.session.id);
        return (
          <div key={node.session.id} style={{ position: "absolute", inset: `${index * SESSION_TREE_ROW_HEIGHT}px 0 auto`, height: SESSION_TREE_ROW_HEIGHT }}>
            <SessionTreeRow
              node={node}
              treeProps={treeProps}
              depth={depth}
              collapsed={collapsed}
              onToggleCollapse={() => setCollapsedIds((current) => {
                const next = new Set(current);
                if (next.has(node.session.id)) next.delete(node.session.id);
                else next.add(node.session.id);
                return next;
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

function SessionTreeRow({
  node,
  treeProps,
  depth,
  collapsed,
  onToggleCollapse,
}: {
  node: SessionTreeNode;
  treeProps: SessionTreeSharedProps;
  depth: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { selectedSessionId, runningSessionIds, unreadSessionIds, pinnedSessionIds, isMobile, openSwipeSessionId, onOpenSwipeSessionChange, onSelectSession, onRenamed, onMoveSession, onTogglePinned, onSessionDeleted } = treeProps;
  const hasChildren = node.children.length > 0;
  return (
    <div
      draggable={!isMobile}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", node.session.id);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const sourceId = event.dataTransfer.getData("text/plain");
        if (sourceId) onMoveSession(sourceId, node.session.id);
      }}
      style={{ position: "relative", height: SESSION_TREE_ROW_HEIGHT, cursor: "grab" }}
    >
      {depth > 0 && <div style={{ position: "absolute", left: depth * 12 + 6, top: 0, bottom: 0, width: 1, background: "var(--border)", pointerEvents: "none" }} />}
      <SessionItem
        session={node.session}
        status={{
          isSelected: node.session.id === selectedSessionId,
          isRunning: runningSessionIds.has(node.session.id),
          isUnread: unreadSessionIds.has(node.session.id),
          isPinned: pinnedSessionIds.has(node.session.id),
        }}
        mobile={{ enabled: isMobile, swipeOpen: openSwipeSessionId === node.session.id, onSwipeOpenChange: (open) => onOpenSwipeSessionChange(node.session.id, open) }}
        actions={{ onClick: () => onSelectSession(node.session), onRenamed, onDeleted: (id) => onSessionDeleted?.(id), onTogglePinned: () => onTogglePinned(node.session.id) }}
        tree={{ depth, hasChildren, collapsed, onToggleCollapse }}
      />
    </div>
  );
}
