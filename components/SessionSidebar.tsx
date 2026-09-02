"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo, WorktreeInfo, WorktreeState } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSessionList } from "@/hooks/useSessionList";
import { useSessionOrder } from "@/hooks/useSessionOrder";
import type { RunningSessionTransitionEvent } from "@/hooks/useRunningSessionTransitions";
import { usePinnedSessions } from "@/hooks/usePinnedSessions";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { WorktreeMutationError } from "@/lib/worktree-client";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionItem } from "./SessionItem";
import { TrashPanel } from "./TrashPanel";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  /** 新会话转正后、服务端列表扫描到文件前用于立即渲染当前会话。 */
  selectedSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  runningSessionIds: ReadonlySet<string>;
  runningSessionTransitions: RunningSessionTransitionEvent;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => void;
  worktreeState?: WorktreeState | null;
  onCreateWorktree?: (branch: string) => Promise<WorktreeInfo>;
  onRemoveWorktree?: (path: string, force: boolean) => Promise<void>;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const PROJECT_DIRECTORIES_STORAGE_KEY = "pi-web:project-directories";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // 浏览器隐私模式或存储配额异常不应阻断目录切换。
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
function loadLegacyProjectDirectories(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_DIRECTORIES_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** 项目树只展示目录名，完整路径保留在悬浮提示中。 */
function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** 优先显示仓库 owner/upstream；未配置时回退到本地分支名。 */
function worktreeBranchLabel(worktree: WorktreeInfo): string | null {
  return worktree.upstreamDisplayBranch ?? worktree.upstreamBranch ?? worktree.branch;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[], manualOrder: string[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // 父子树结构不变；同层节点按统一的手动顺序排列。
  const orderIndex = new Map(manualOrder.map((id, index) => [id, index]));
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((left, right) => (orderIndex.get(left.session.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.session.id) ?? Number.MAX_SAFE_INTEGER));
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}
export function SessionSidebar({ selectedSessionId, selectedSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, runningSessionIds, runningSessionTransitions, selectedCwd: selectedCwdProp, onCwdChange, worktreeState = null, onCreateWorktree, onRemoveWorktree, onOpenFile, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onSessionsChange }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const {
    sessions: allSessions,
    removeSessions,
    loading,
    error,
    refreshDone: sessionRefreshDone,
    loadSessions,
  } = useSessionList({ refreshKey, onSessionsChange });
  const { order: sessionOrder, moveSession } = useSessionOrder(allSessions);
  const { pinnedIds, togglePinned } = usePinnedSessions(allSessions);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [validatedProject, setValidatedProject] = useState<{ cwd: string; projectRoot?: string; projectKey?: string } | null>(null);
  // 服务端与客户端首屏都从空列表开始，挂载后再恢复本地目录，避免 hydration 不一致。
  const [knownProjects, setKnownProjects] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string>("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<string | null>(null);
  const [projectRemovalBusy, setProjectRemovalBusy] = useState(false);
  const [projectRemovalError, setProjectRemovalError] = useState<string | null>(null);
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  // Worktree switcher UI state; data is owned and loaded by AppShell.
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [openSwipeSessionId, setOpenSwipeSessionId] = useState<string | null>(null);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [trashOpen, setTrashOpen] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  useEffect(() => {
    if (loading || error) return;
    const existingIds = new Set(allSessions.map((session) => session.id));
    setUnreadSessionIds((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [allSessions, error, loading]);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const refreshVisibleSessions = async () => {
      if (document.visibilityState !== "visible") return;
      const cwd = selectedCwdProp ?? selectedCwd;
      if (cwd) {
        try {
          const response = await fetch(`/api/git/context?cwd=${encodeURIComponent(cwd)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) console.error("刷新当前 Git 分支失败", await response.text());
        } catch (error) {
          if (!controller.signal.aborted) console.error("刷新当前 Git 分支失败", error);
        }
      }
      if (!stopped) await loadSessions(false);
    };
    const handleVisibilityChange = () => { void refreshVisibleSessions(); };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      controller.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadSessions, selectedCwd, selectedCwdProp]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/project-directories", { cache: "no-store" });
        const data = await response.json() as { projects?: string[]; error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);

        let projects = data.projects ?? [];
        const legacyProjects = loadLegacyProjectDirectories();
        for (const cwd of legacyProjects) {
          const migration = await fetch("/api/project-directories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd }),
          });
          if (!migration.ok) continue;
          const migrated = await migration.json() as { projects?: string[] };
          projects = migrated.projects ?? projects;
        }
        window.localStorage.removeItem(PROJECT_DIRECTORIES_STORAGE_KEY);
        if (!cancelled) setKnownProjects(projects);
      } catch (error) {
        console.error("加载 Pi Web 项目目录失败", error);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);


  useEffect(() => {
    setUnreadSessionIds((prev) => {
      if (![...runningSessionIds].some((sessionId) => prev.has(sessionId))) return prev;
      const next = new Set(prev);
      runningSessionIds.forEach((sessionId) => next.delete(sessionId));
      return next;
    });
  }, [runningSessionIds]);

  useEffect(() => {
    if (runningSessionTransitions.revision === 0) return;
    const { completedInBackground, started } = runningSessionTransitions;
    if (completedInBackground.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        completedInBackground.forEach((sessionId) => next.add(sessionId));
        return next;
      });
    }
    // 新会话开始运行或后台会话完成时刷新列表；当前会话完成由 ChatWindow 刷新。
    if (completedInBackground.length > 0 || started.length > 0) void loadSessions(false);
  }, [loadSessions, runningSessionTransitions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (validatedProject?.cwd === cwd) return validatedProject.projectRoot ?? cwd;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [validatedProject, worktreeState, allSessions]);

  const projectKeyFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (validatedProject?.cwd === cwd) return validatedProject.projectKey ?? validatedProject.projectRoot ?? cwd;
    const match = allSessions.find((session) => session.cwd === cwd);
    return match?.projectKey ?? match?.projectRoot ?? projectRootFor(cwd);
  }, [allSessions, projectRootFor, validatedProject]);

  // 先采用用户刚选择的精确路径，待接口刷新后改用服务端解析的 checkout 身份。
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd), projectKeyFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectKeyFor, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);


  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0]);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const validateResponse = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const validated = await validateResponse.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!validateResponse.ok || !validated.cwd) {
        setCustomPathError(validated.error ?? `HTTP ${validateResponse.status}`);
        return;
      }
      setValidatedProject({
        cwd: validated.cwd,
        projectRoot: validated.projectRoot,
        projectKey: validated.projectKey,
      });
      const res = await fetch("/api/project-directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: validated.cwd }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; projects?: string[]; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSelectedCwd(data.cwd ?? validated.cwd);
      const cwd = data.cwd ?? validated.cwd;
      saveLastCustomCwd(cwd);
      setCustomPathValue(cwd);
      setKnownProjects((current) => {
        return data.projects ?? [cwd, ...current.filter((project) => project !== cwd)].filter((project): project is string => typeof project === "string");
      });
      setCustomPathOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathValue(loadLastCustomCwd());
    setCustomPathOpen(true);
    setCustomPathError(null);
  }, []);
  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !onCreateWorktree) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const created = await onCreateWorktree(branch);
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      setSelectedCwd(created.path);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, onCreateWorktree]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy || !onRemoveWorktree) return;
    setWtBusy(true);
    setWtError(null);
    try {
      await onRemoveWorktree(path, force);
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
    } catch (e) {
      if (e instanceof WorktreeMutationError && e.dirty && !force) {
        setWtConfirmRemove(path);
        return;
      }
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath, onRemoveWorktree]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    setOpenSwipeSessionId(null);
    if (s.id === selectedSessionId) return;
    if (s.cwd) setSelectedCwd(s.cwd);
    if (!s.path) return;
    onSelectSession(s);
  }, [onSelectSession, selectedSessionId]);

  const handleNewSession = useCallback((cwd: string) => {
    setSelectedCwd(cwd);
    onNewSession?.(cwd, cwd);
  }, [onNewSession]);

  const visibleSessions = useMemo(
    () => selectedSession && !allSessions.some((session) => session.id === selectedSession.id)
      ? [selectedSession, ...allSessions]
      : allSessions,
    [allSessions, selectedSession],
  );
  const displayProject = (session: SessionInfo) => session.isWorktree ? session.cwd : (session.projectRoot ?? session.cwd);
  const recentProjects = [...new Set(visibleSessions.map(displayProject))];
  const selectedProject = projectRootFor(selectedCwd);
  const projectActivity = useMemo(() => {
    const counts = new Map<string, { running: number; unread: number }>();
    for (const session of visibleSessions) {
      const key = displayProject(session);
      const current = counts.get(key) ?? { running: 0, unread: 0 };
      if (runningSessionIds.has(session.id)) current.running += 1;
      if (unreadSessionIds.has(session.id)) current.unread += 1;
      counts.set(key, current);
    }
    return counts;
  }, [runningSessionIds, unreadSessionIds, visibleSessions]);
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(([key, value]) => key !== selectedProject && (value.running > 0 || value.unread > 0)),
    [projectActivity, selectedProject],
  );
  const selectedDisplayProject = visibleSessions.find((session) => session.cwd === selectedCwd)
    ? displayProject(visibleSessions.find((session) => session.cwd === selectedCwd)!)
    : selectedProject;
  const visibleProjects = [...new Set([
    ...(selectedProject ? [selectedProject] : []),
    ...recentProjects,
    ...knownProjects,
  ])].sort((left, right) => projectName(left).localeCompare(projectName(right), undefined, {
    sensitivity: "base",
    numeric: true,
  }));
  // Worktree 选择只放在新会话输入框中，侧边栏不再提供第二个切换入口。
  const showWorktreeSwitcher = false;
  const inactiveWorktreeSelector = (() => null as { label: string; title: string } | null)();

  const handleRemoveProject = useCallback(async () => {
    if (!projectPendingRemoval || projectRemovalBusy) return;

    setProjectRemovalBusy(true);
    setProjectRemovalError(null);
    const sessions = allSessions.filter((session) => (session.projectRoot ?? session.cwd) === projectPendingRemoval);
    try {
      for (const session of sessions) {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        onSessionDeleted?.(session.id);
      }

      const removeResponse = await fetch("/api/project-directories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPendingRemoval }),
      });
      const removeData = await removeResponse.json().catch(() => ({})) as { projects?: string[]; error?: string };
      if (!removeResponse.ok || removeData.error) throw new Error(removeData.error ?? `HTTP ${removeResponse.status}`);

      removeSessions(sessions.map((session) => session.id));
      setKnownProjects(removeData.projects ?? []);
      setCollapsedProjects((current) => {
        const next = new Set(current);
        next.delete(projectPendingRemoval);
        return next;
      });
      if (selectedProject === projectPendingRemoval) {
        const nextProject = visibleProjects.find((project) => project !== projectPendingRemoval);
        if (nextProject) await commitCustomPath(nextProject);
        else setSelectedCwd(null);
      }
      setProjectPendingRemoval(null);
    } catch (cause) {
      console.error("移除项目目录失败", cause);
      setProjectRemovalError(cause instanceof Error ? cause.message : String(cause));
      await loadSessions(false);
    } finally {
      setProjectRemovalBusy(false);
    }
  }, [allSessions, commitCustomPath, loadSessions, onSessionDeleted, projectPendingRemoval, projectRemovalBusy, removeSessions, selectedProject, visibleProjects]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue || undefined}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {trashOpen && (
        <TrashPanel
          onClose={() => setTrashOpen(false)}
          // 恢复后保持面板打开，便于连续恢复多个会话；侧边栏同步刷新
          onRestored={() => loadSessions()}
        />
      )}
      {projectPendingRemoval && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-project-title"
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.42)" }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !projectRemovalBusy) setProjectPendingRemoval(null);
          }}
        >
          <div style={{ width: 380, maxWidth: "100%", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)" }}>
            <h2 id="remove-project-title" style={{ margin: 0, color: "var(--text)", fontSize: 15, lineHeight: 1.4 }}>
              {t("sidebar.removeProjectTitle", { name: projectName(projectPendingRemoval) })}
            </h2>
            <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
              {t("sidebar.removeProjectDescription", { count: allSessions.filter((session) => (session.projectRoot ?? session.cwd) === projectPendingRemoval).length })}
            </p>
            {projectRemovalError && (
              <p role="alert" style={{ margin: "8px 0 0", color: "#ef4444", fontSize: 11, overflowWrap: "anywhere" }}>{projectRemovalError}</p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" disabled={projectRemovalBusy} onClick={() => setProjectPendingRemoval(null)} style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: projectRemovalBusy ? "default" : "pointer" }}>
                {t("sidebar.cancel")}
              </button>
              <button type="button" disabled={projectRemovalBusy} onClick={() => void handleRemoveProject()} style={{ height: 32, padding: "0 12px", border: 0, borderRadius: 6, background: "#dc2626", color: "#fff", fontWeight: 600, cursor: projectRemovalBusy ? "default" : "pointer", opacity: projectRemovalBusy ? 0.65 : 1 }}>
                {projectRemovalBusy ? t("sidebar.removingProject") : t("sidebar.removeProject")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <PiWebTitle />
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{ width: 7, height: 7, marginLeft: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleCustomPathClick}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: "pointer",
                width: 32,
                height: 32,
                padding: 0,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              title={t("sidebar.customPath")}
              aria-label={t("sidebar.customPath")}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
            </button>
            <button
              onClick={() => loadSessions(false)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
               title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
            <button
              onClick={() => setTrashOpen(true)}
              title={t("trash.title")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          </div>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && worktreeState && worktreeState.worktrees.length > 1 && (() => {
          if (!worktreeState) return null;
          const currentWt = currentWorktree;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (worktreeBranchLabel(w) ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWt ? t("sidebar.switchWorktreeTitle", { path: currentWt.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWt && !currentWt.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWt ? (worktreeBranchLabel(currentWt) ?? displayCwd(currentWt.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={worktreeBranchLabel(wt) ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector?.title ?? ""}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector?.label}</span>
          </button>
        )}
      </div>

      {/* 项目目录与会话组成同一棵导航树，减少在目录选择器和会话列表之间切换。 */}
      <div style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && visibleProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.selectProject")}
          </div>
        )}
        {visibleProjects.map((project) => {
          const collapsed = collapsedProjects.has(project);
          const projectSessions = visibleSessions.filter((session) => displayProject(session) === project);
          const projectTree = buildSessionTree(projectSessions, sessionOrder);
          const active = project === selectedDisplayProject;
          const treeProps: SessionTreeSharedProps = {
            selectedSessionId,
            runningSessionIds,
            unreadSessionIds,
            pinnedSessionIds: pinnedIds,
            isMobile,
            openSwipeSessionId,
            onOpenSwipeSessionChange: (sessionId, open) => setOpenSwipeSessionId(open ? sessionId : null),
            onSelectSession: handleSelectSessionFromList,
            onRenamed: loadSessions,
            onMoveSession: moveSession,
            onTogglePinned: togglePinned,
            onSessionDeleted: (id) => {
              onSessionDeleted?.(id);
              loadSessions();
            },
          };
          return (
            <section key={project} style={{ padding: "2px 6px 6px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  minHeight: 34,
                  borderRadius: 6,
                  background: active ? "var(--bg-hover)" : "transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    void commitCustomPath(project);
                    setCollapsedProjects((current) => {
                      const next = new Set(current);
                      if (next.has(project)) next.delete(project);
                      else next.add(project);
                      return next;
                    });
                  }}
                  title={project}
                  aria-expanded={!collapsed}
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
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s", flexShrink: 0 }}>
                    <polyline points="3 2 7 5 3 8" />
                  </svg>
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                    <path d="M2.5 5.5h5l1.7 2h8.3v7.5a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5.5Z" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 }}>
                    {projectName(project)}
                  </span>
                  {showProjectActivity(projectActivity.get(project), t)}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProjectRemovalError(null);
                    setProjectPendingRemoval(project);
                  }}
                  title={t("sidebar.removeProjectButton", { name: projectName(project) })}
                  aria-label={t("sidebar.removeProjectButton", { name: projectName(project) })}
                  style={{ width: 28, height: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <line x1="2" y1="6" x2="10" y2="6" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleNewSession(project)}
                  title={t("sidebar.newSessionTitle", { path: project })}
                  aria-label={t("sidebar.newSessionTitle", { path: project })}
                  style={{ width: 28, height: 28, padding: 0, marginRight: 3, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <line x1="6" y1="1" x2="6" y2="11" />
                    <line x1="1" y1="6" x2="11" y2="6" />
                  </svg>
                </button>
              </div>
              {active && !collapsed && showWorktreeSwitcher && worktreeState && (() => {
                return (
                  <label
                    title={currentWorktree?.path}
                    style={{ display: "flex", alignItems: "center", gap: 6, height: 28, margin: "0 6px 2px 30px", color: "var(--text-dim)" }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <select
                      aria-label={t("sidebar.switchWorktree")}
                      value={currentWorktree?.path ?? ""}
                      onChange={(event) => setSelectedCwd(event.target.value)}
                      style={{ minWidth: 0, flex: 1, height: 26, padding: "0 24px 0 0", border: 0, outline: 0, background: "transparent", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer" }}
                    >
                      {worktreeState.worktrees.map((worktree) => (
                        <option key={worktree.path} value={worktree.path}>
                          {worktreeBranchLabel(worktree) ?? projectName(worktree.path)}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })()}
              {!collapsed && (
                <div style={{ paddingLeft: 24 }}>
                  {projectTree.length === 0 ? (
                    <div style={{ padding: "5px 10px 7px", color: "var(--text-dim)", fontSize: 11 }}>{t("sidebar.noSessions")}</div>
                  ) : projectTree.map((node) => (
                    <SessionTreeItem
                      key={node.session.id}
                      node={node}
                      treeProps={treeProps}
                      depth={0}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((open) => {
                const nextOpen = !open;
                saveExplorerOpen(nextOpen);
                return nextOpen;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("files.explorer")}
            </button>
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => setFileSearchOpen((open) => !open)}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
interface SessionTreeSharedProps {
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

function SessionTreeItem({
  node,
  treeProps,
  depth,
}: {
  node: SessionTreeNode;
  treeProps: SessionTreeSharedProps;
  depth: number;
}) {
  const { selectedSessionId, runningSessionIds, unreadSessionIds, pinnedSessionIds, isMobile, openSwipeSessionId, onOpenSwipeSessionChange, onSelectSession, onRenamed, onMoveSession, onTogglePinned, onSessionDeleted } = treeProps;
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
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
        style={{ position: "relative", cursor: "grab" }}
      >
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          status={{
            isSelected: node.session.id === selectedSessionId,
            isRunning: runningSessionIds.has(node.session.id),
            isUnread: unreadSessionIds.has(node.session.id),
            isPinned: pinnedSessionIds.has(node.session.id),
          }}
          mobile={{
            enabled: isMobile,
            swipeOpen: openSwipeSessionId === node.session.id,
            onSwipeOpenChange: (open) => onOpenSwipeSessionChange(node.session.id, open),
          }}
          actions={{
            onClick: () => onSelectSession(node.session),
            onRenamed,
            onDeleted: (id) => onSessionDeleted?.(id),
            onTogglePinned: () => onTogglePinned(node.session.id),
          }}
          tree={{
            depth,
            hasChildren,
            collapsed,
            onToggleCollapse: () => setCollapsed((value) => !value),
          }}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              treeProps={treeProps}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)" }}>
      {activity.running > 0 && <span title={t("sidebar.agentRunning")} aria-label={`${t("sidebar.agentRunning")} (${activity.running})`} style={{ color: "var(--accent)" }}>~{activity.running}</span>}
      {activity.unread > 0 && <span title={t("sidebar.newSessionActivity")} aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`} style={{ color: "#0891b2" }}>+{activity.unread}</span>}
    </span>
  );
}
