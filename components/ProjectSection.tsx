"use client";

import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { BackgroundActivityMap } from "@/hooks/useRunningSessions";
import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { buildSessionTree, type SessionTreeNode } from "@/lib/session-tree";
import { portablePathIdentity } from "@/lib/path-equality";
import { sidebarProjectPath } from "@/lib/project-groups";
import { SessionItem } from "./SessionItem";
import { ProjectMark } from "./ProjectMark";
import type { SessionPinColor } from "@/lib/sidebar-preference-state";

interface ProjectSectionProps {
  project: {
    path: string;
    name: string;
    active: boolean;
    collapsed: boolean;
    isMobile: boolean;
    activity?: ReactNode;
    sessions: SessionInfo[];
    sessionOrder: string[];
    layoutVersion?: ReadonlySet<string>;
  };
  labels: {
    empty: string;
    remove: string;
    newSession: string;
  };
  actions: {
    onToggleCollapsed: () => void;
    onMove: (source: string, target: string) => void;
    onRemove: () => void;
    onNewSession: () => void;
  };
  children?: ReactNode;
  treeProps: SessionTreeSharedProps;
}

const PROJECT_DRAG_TYPE = "application/x-pi-project";

/** 单个项目目录的条件编排；数据持久化由父层负责。 */
export function ProjectSection({ project, labels, actions, treeProps, children }: ProjectSectionProps) {
  const tree = useMemo(() => buildSessionTree(project.sessions, project.sessionOrder), [project.sessionOrder, project.sessions]);
  const handledLocateRevisionRef = useRef(0);
  return (
    <section style={{ padding: "2px 6px 6px" }}>
      <ProjectHeader project={project} labels={labels} actions={actions} />
      {!project.collapsed && (
        <div style={{ paddingLeft: 16 }}>
          {tree.length > 0 ? (
            <VirtualizedSessionTree
              tree={tree}
              treeProps={treeProps}
              handledLocateRevisionRef={handledLocateRevisionRef}
              layoutVersion={project.layoutVersion}
            />
          ) : !children && (
            <div style={{ padding: "5px 10px 7px", color: "var(--text-dim)", fontSize: 11 }}>{labels.empty}</div>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

function ProjectIcon({ path, collapsed }: { path: string; collapsed: boolean }) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const FolderIcon = collapsed ? Folder : FolderOpen;
  const query = new URLSearchParams({ project: path });

  return (
    <span aria-hidden="true" style={{ position: "relative", width: 16, height: 16, flexShrink: 0 }}>
      {status !== "ready" && (
        <FolderIcon size={16} strokeWidth={1.7} data-project-folder-icon={collapsed ? "closed" : "open"} />
      )}
      {status !== "failed" && (
        // 项目图标来自已授权的本地文件，无需交给 Next.js 的图片优化服务。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/project-icon?${query}`}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("failed")}
          style={{ position: "absolute", inset: 0, objectFit: "contain", opacity: status === "ready" ? 1 : 0 }}
        />
      )}
    </span>
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
        <ProjectIcon key={project.path} path={project.path} collapsed={project.collapsed} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 }}>{project.name}</span>
        {project.activity}
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

/** 置顶区的一个项目分组，子代理继续跟随所属的根会话。 */
interface PinnedProjectGroup {
  identity: string;
  path: string;
  name: string;
  tree: SessionTreeNode[];
}

/** 先按置顶顺序构建会话树，再合并同项目的根节点，保留组序、组内顺序与子代理层级。 */
function groupPinnedSessions(
  tree: SessionTreeNode[],
  resolveProject?: (session: SessionInfo) => { name: string; path: string },
): PinnedProjectGroup[] {
  const groups = new Map<string, PinnedProjectGroup>();
  for (const node of tree) {
    const project = resolveProject?.(node.session);
    const path = node.session.isWorktree ? (node.session.projectRoot ?? project?.path ?? "") : (project?.path ?? "");
    // 与下方项目列表共用路径身份；原始路径只用于展示和请求图标。
    const identity = path ? portablePathIdentity(path) : "";
    const existing = groups.get(identity);
    if (existing) {
      existing.tree.push(node);
      continue;
    }
    groups.set(identity, { identity, path, name: path && path !== project?.path ? path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path : project?.name ?? "", tree: [node] });
  }
  return [...groups.values()];
}

/** 顶部置顶会话按项目分组；不改变下方项目区的外观和折叠状态。 */
export function PinnedSessionsSection({
  title,
  sessions,
  sessionOrder,
  treeProps,
  onNewSession,
  formatNewSessionLabel,
}: {
  title: string;
  sessions: SessionInfo[];
  sessionOrder: string[];
  treeProps: SessionTreeSharedProps;
  onNewSession?: (path: string) => void;
  formatNewSessionLabel?: (name: string) => string;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const handledGroupLocateRevisionRef = useRef(0);
  const groups = useMemo(
    () => groupPinnedSessions(
      buildSessionTree(sessions, sessionOrder, { independentRootIds: treeProps.topPinnedSessionIds }),
      treeProps.resolveProject,
    ),
    [sessions, sessionOrder, treeProps.resolveProject, treeProps.topPinnedSessionIds],
  );

  useLayoutEffect(() => {
    const request = treeProps.locateSessionRequest;
    if (!request || handledGroupLocateRevisionRef.current === request.revision) return;
    const group = groups.find((candidate) => findSessionAncestorIds(candidate.tree, request.sessionId) !== null);
    if (!group) return;
    handledGroupLocateRevisionRef.current = request.revision;
    setCollapsedGroups((current) => {
      const rootNode = group.tree.find((node) => findSessionAncestorIds([node], request.sessionId) !== null);
      const checkoutIdentity = rootNode ? portablePathIdentity(sidebarProjectPath(rootNode.session)) : group.identity;
      if (!current.has(group.identity) && !current.has(checkoutIdentity)) return current;
      const next = new Set(current);
      next.delete(group.identity);
      next.delete(checkoutIdentity);
      return next;
    });
  }, [groups, treeProps.locateSessionRequest]);

  if (groups.length === 0) return null;
  return (
    <section data-pinned-sessions-section style={{ padding: "6px 6px 8px" }}>
      <div style={{ padding: "4px 8px 4px 10px", fontSize: 11, fontWeight: 500, color: "var(--text-dim)", userSelect: "none" }}>
        {title}
      </div>
      {groups.map((group) => (
        <PinnedProjectGroupSection
          key={group.identity}
          group={group}
          treeProps={treeProps}
          onNewSession={onNewSession}
          formatNewSessionLabel={formatNewSessionLabel}
          layoutVersion={collapsedGroups}
          collapsed={collapsedGroups.has(group.identity)}
          onToggleGroup={(identity) => setCollapsedGroups((current) => {
            const next = new Set(current);
            if (next.has(identity)) next.delete(identity);
            else next.add(identity);
            return next;
          })}
        />
      ))}
    </section>
  );
}

function PinnedProjectGroupSection({
  group,
  treeProps,
  onNewSession,
  formatNewSessionLabel,
  layoutVersion,
  collapsed,
  onToggleGroup,
}: {
  group: PinnedProjectGroup;
  treeProps: SessionTreeSharedProps;
  onNewSession?: (path: string) => void;
  formatNewSessionLabel?: (name: string) => string;
  layoutVersion: ReadonlySet<string>;
  collapsed: boolean;
  onToggleGroup: (identity: string) => void;
}) {
  // 目录信息只在组头显示，行内继续保留时间、消息数和运行状态。
  const groupTreeProps = useMemo(() => ({ ...treeProps, resolveProject: undefined }), [treeProps]);
  const handledLocateRevisionRef = useRef(0);
  const { mainTree, worktreeGroups } = useMemo(() => {
    const mainTree: SessionTreeNode[] = [];
    const worktrees = new Map<string, PinnedProjectGroup>();
    for (const node of group.tree) {
      const path = sidebarProjectPath(node.session);
      const identity = portablePathIdentity(path);
      if (!node.session.isWorktree || identity === group.identity) {
        mainTree.push(node);
        continue;
      }
      const existing = worktrees.get(identity);
      if (existing) existing.tree.push(node);
      else worktrees.set(identity, {
        identity,
        path,
        name: path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path,
        tree: [node],
      });
    }
    return { mainTree, worktreeGroups: [...worktrees.values()] };
  }, [group]);
  return (
    <div data-pinned-group={group.path || undefined}>
      {group.path !== "" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: 30,
            borderRadius: 6,
          }}
        >
          <button
            type="button"
            onClick={() => onToggleGroup(group.identity)}
            title={group.path}
            aria-expanded={!collapsed}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              flex: 1,
              minWidth: 0,
              height: 30,
              padding: "0 4px 0 6px",
              border: 0,
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <ChevronRight
              size={12}
              strokeWidth={2.2}
              aria-hidden="true"
              style={{ flexShrink: 0, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 120ms ease" }}
            />
            <ProjectMark path={group.path} name={group.name} size={16} />
            <span data-pinned-group-name style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{group.name}</span>
            <span data-pinned-group-count style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11, fontWeight: 500 }}>{group.tree.length}</span>
          </button>
          {onNewSession && (
            <button
              type="button"
              data-pinned-group-new-session
              onClick={() => onNewSession(group.path)}
              title={formatNewSessionLabel ? formatNewSessionLabel(group.name) : group.name}
              aria-label={formatNewSessionLabel ? formatNewSessionLabel(group.name) : group.name}
              style={{
                width: 26,
                height: 26,
                padding: 0,
                marginRight: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: 0,
                borderRadius: 5,
                background: "transparent",
                color: "var(--text-dim)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
            </button>
          )}
        </div>
      )}
      {!collapsed && (
        <div style={{ paddingLeft: group.path === "" ? 0 : 16 }}>
          <VirtualizedSessionTree
            tree={mainTree}
            treeProps={groupTreeProps}
            handledLocateRevisionRef={handledLocateRevisionRef}
            layoutVersion={layoutVersion}
          />
          {worktreeGroups.map((worktree) => (
            <PinnedProjectGroupSection
              key={worktree.identity}
              group={worktree}
              treeProps={treeProps}
              onNewSession={onNewSession}
              formatNewSessionLabel={formatNewSessionLabel}
              layoutVersion={layoutVersion}
              collapsed={layoutVersion.has(worktree.identity)}
              onToggleGroup={onToggleGroup}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface SessionTreeSharedProps {
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  awaitingInputSessionIds?: ReadonlySet<string>;
  backgroundActivity?: BackgroundActivityMap;
  startingSessions?: ReadonlyMap<string, string>;
  unreadSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  sessionPinColors: ReadonlyMap<string, SessionPinColor>;
  topPinnedSessionIds?: ReadonlySet<string>;
  resolveProject?: (session: SessionInfo) => { name: string; path: string };
  locateSessionRequest?: { sessionId: string; revision: number } | null;
  isMobile: boolean;
  openSwipeSessionId: string | null;
  onOpenSwipeSessionChange: (sessionId: string, open: boolean) => void;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onMoveSession: (sourceId: string, targetId: string) => void;
  onTogglePinned: (sessionId: string) => void;
  onToggleTopPinned?: (sessionId: string) => void;
  onSetPinColor: (sessionId: string, color: SessionPinColor) => void;
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
  layoutVersion,
}: {
  tree: SessionTreeNode[];
  treeProps: SessionTreeSharedProps;
  handledLocateRevisionRef: { current: number };
  /** 置顶组折叠会改变后续组的位置，需要重新计算它们的可见范围。 */
  layoutVersion?: ReadonlySet<string>;
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
    // 顶部组的高度变化也会移动下方项目列表；一并监听，避免需要滚动才补出可见行。
    const pinnedSection = scroll.querySelector<HTMLElement>("[data-pinned-sessions-section]");
    if (pinnedSection) resizeObserver.observe(pinnedSection);
    return () => {
      scroll.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [rows, treeProps.selectedSessionId, layoutVersion]);

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
  const { selectedSessionId, runningSessionIds, awaitingInputSessionIds, backgroundActivity, startingSessions, unreadSessionIds, pinnedSessionIds, topPinnedSessionIds, sessionPinColors, resolveProject, isMobile, openSwipeSessionId, onOpenSwipeSessionChange, onSelectSession, onRenamed, onMoveSession, onToggleTopPinned, onTogglePinned, onSetPinColor, onSessionDeleted } = treeProps;
  const hasChildren = node.children.length > 0;
  const background = backgroundActivity?.get(node.session.id);
  return (
    <div
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
          isAwaitingInput: awaitingInputSessionIds?.has(node.session.id) ?? false,
          backgroundCommands: background?.commands ?? 0,
          nextScheduledTaskAt: background?.nextTaskAt ?? null,
          startingFirstMessage: startingSessions?.get(node.session.id),
          isUnread: unreadSessionIds.has(node.session.id),
          isPinned: pinnedSessionIds.has(node.session.id),
          isTopPinned: topPinnedSessionIds?.has(node.session.id) ?? false,
          pinColor: sessionPinColors.get(node.session.id),
        }}
        mobile={{ enabled: isMobile, swipeOpen: openSwipeSessionId === node.session.id, onSwipeOpenChange: (open) => onOpenSwipeSessionChange(node.session.id, open) }}
        actions={{ onClick: () => onSelectSession(node.session), onRenamed, onDeleted: (id) => onSessionDeleted?.(id), onToggleTopPinned: onToggleTopPinned ? () => onToggleTopPinned(node.session.id) : undefined, onTogglePinned: () => onTogglePinned(node.session.id), onSetPinColor: (color) => onSetPinColor(node.session.id, color) }}
        tree={{ depth, hasChildren, collapsed, onToggleCollapse }}
        project={resolveProject?.(node.session)}
      />
    </div>
  );
}
