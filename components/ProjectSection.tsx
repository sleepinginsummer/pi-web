"use client";

import { Pin as PinIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { buildSessionTree, type SessionTreeNode } from "@/lib/session-tree";
import { SessionItem } from "./SessionItem";

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
}

const PROJECT_DRAG_TYPE = "application/x-pi-project";

/** 单个项目目录的条件编排；数据持久化由父层负责。 */
export function ProjectSection({ project, labels, actions, treeProps }: ProjectSectionProps) {
  const tree = useMemo(() => buildSessionTree(project.sessions, project.sessionOrder), [project.sessionOrder, project.sessions]);
  const handledLocateRevisionRef = useRef(0);
  return (
    <section style={{ padding: "2px 6px 6px" }}>
      <ProjectHeader project={project} labels={labels} actions={actions} />
      {!project.collapsed && (
        <div style={{ paddingLeft: 24 }}>
          {tree.length > 0 ? (
            <VirtualizedSessionTree
              tree={tree}
              treeProps={treeProps}
              handledLocateRevisionRef={handledLocateRevisionRef}
            />
          ) : (
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



export interface SessionTreeSharedProps {
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  unreadSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  locateSessionRequest?: { sessionId: string; revision: number } | null;
  isMobile: boolean;
  openSwipeSessionId: string | null;
  onOpenSwipeSessionChange: (sessionId: string, open: boolean) => void;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onMoveSession: (sourceId: string, targetId: string) => void;
  onTogglePinned: (sessionId: string) => void;
  onSessionDeleted?: (id: string) => void;
}


const SESSION_TREE_ROW_HEIGHT = 54;
const SESSION_TREE_OVERSCAN = 6;

interface FlatSessionTreeRow {
  node: SessionTreeNode;
  depth: number;
}

function findSessionAncestorIds(
  nodes: SessionTreeNode[],
  targetSessionId: string,
  ancestors: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.session.id === targetSessionId) return ancestors;
    const result = findSessionAncestorIds(node.children, targetSessionId, [...ancestors, node.session.id]);
    if (result) return result;
  }
  return null;
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

function VirtualizedSessionTree({
  tree,
  treeProps,
  handledLocateRevisionRef,
}: {
  tree: SessionTreeNode[];
  treeProps: SessionTreeSharedProps;
  handledLocateRevisionRef: { current: number };
}) {
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

  useLayoutEffect(() => {
    const request = treeProps.locateSessionRequest;
    if (!request || handledLocateRevisionRef.current === request.revision) return;

    const targetIndex = rows.findIndex((row) => row.node.session.id === request.sessionId);
    if (targetIndex < 0) {
      const ancestorIds = findSessionAncestorIds(tree, request.sessionId);
      if (!ancestorIds) return;
      setCollapsedIds((current) => {
        const next = new Set(current);
        let changed = false;
        for (const ancestorId of ancestorIds) {
          if (next.delete(ancestorId)) changed = true;
        }
        return changed ? next : current;
      });
      return;
    }

    const wrapper = wrapperRef.current;
    const scroll = wrapper?.closest<HTMLElement>("[data-session-scroll]");
    if (!wrapper || !scroll) return;
    const wrapperTop = scroll.scrollTop + wrapper.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    const targetTop = wrapperTop + targetIndex * SESSION_TREE_ROW_HEIGHT;
    const top = Math.max(0, targetTop - (scroll.clientHeight - SESSION_TREE_ROW_HEIGHT) / 2);
    scroll.scrollTo({ top, behavior: "auto" });
    handledLocateRevisionRef.current = request.revision;
  }, [handledLocateRevisionRef, rows, tree, treeProps.locateSessionRequest]);

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
