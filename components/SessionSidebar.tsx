"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import type { SessionInfo, WorktreeState } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSessionList } from "@/hooks/useSessionList";
import { useSidebarNavigation } from "@/hooks/useSidebarNavigation";
import type { RunningSessionTransitionEvent } from "@/hooks/useRunningSessionTransitions";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { loadCollapsedProjects, saveCollapsedProjects } from "@/lib/project-collapse-state";
import { getProjectActivity, getRecentProjects, resolveSidebarProjectPath, sessionsForProject, sidebarProjectPath } from "@/lib/project-groups";
import { commitCustomProjectSelection } from "@/lib/custom-project-selection";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { ProjectSection, type SessionTreeSharedProps } from "./ProjectSection";
import { TrashPanel } from "./TrashPanel";
import { SessionSearch } from "./SessionSearch";

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
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  runningSessionIds: ReadonlySet<string>;
  runningSessionTransitions: RunningSessionTransitionEvent;
  locateSessionRequest?: { sessionId: string; revision: number } | null;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => void;
  worktreeState?: WorktreeState | null;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
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

/** 项目树只展示目录名，完整路径保留在悬浮提示中。 */
function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
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
export function SessionSidebar({ selectedSessionId, selectedSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, runningSessionIds, runningSessionTransitions, locateSessionRequest, selectedCwd: selectedCwdProp, onCwdChange, worktreeState = null, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onSessionsChange }: Props) {
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
  const {
    sessionOrder,
    pinnedSessionIds: pinnedIds,
    pinnedProjectPaths,
    getProjectOrder,
    moveSession,
    toggleSessionPinned: togglePinned,
    moveProject,
    toggleProjectPinned,
    projects: knownProjects,
    addProject,
    removeProject,
  } = useSidebarNavigation(allSessions, !loading && !error);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [validatedProject, setValidatedProject] = useState<{ cwd: string; projectRoot?: string; projectKey?: string } | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedProjectsReady, setCollapsedProjectsReady] = useState(false);
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<string | null>(null);
  const [projectRemovalBusy, setProjectRemovalBusy] = useState(false);
  const [projectRemovalError, setProjectRemovalError] = useState<string | null>(null);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
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
    setCollapsedProjects(loadCollapsedProjects());
    setCollapsedProjectsReady(true);
  }, []);

  useEffect(() => {
    if (!collapsedProjectsReady) return;
    saveCollapsedProjects(collapsedProjects);
  }, [collapsedProjects, collapsedProjectsReady]);



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
      await commitCustomProjectSelection(path, {
        validateProject: async (candidate) => {
          const validateResponse = await fetch("/api/cwd/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: candidate }),
          });
          const validated = await validateResponse.json().catch(() => ({})) as {
            cwd?: string;
            projectRoot?: string;
            projectKey?: string;
            error?: string;
          };
          if (!validateResponse.ok || !validated.cwd) {
            throw new Error(validated.error ?? `HTTP ${validateResponse.status}`);
          }
          return {
            cwd: validated.cwd,
            projectRoot: validated.projectRoot,
            projectKey: validated.projectKey,
          };
        },
        installValidatedProject: setValidatedProject,
        addProject,
        selectCwd: setSelectedCwd,
        commitSelection: (cwd) => {
          saveLastCustomCwd(cwd);
          setCustomPathValue(cwd);
          setCustomPathOpen(false);
        },
      });
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [addProject, customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathValue(loadLastCustomCwd());
    setCustomPathOpen(true);
    setCustomPathError(null);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setOpenSwipeSessionId(null);
    if (s.id === selectedSessionId && !entryId) return;
    if (s.cwd) setSelectedCwd(s.cwd);
    if (!s.path) return;
    onSelectSession(s, false, entryId, blockIndex);
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
  const recentProjects = getRecentProjects(visibleSessions);
  const selectedProject = resolveSidebarProjectPath(visibleSessions, selectedCwd, {
    projectRoot: projectRootFor(selectedCwd),
    worktrees: worktreeState?.worktrees,
  });
  const projectActivity = useMemo(
    () => getProjectActivity(visibleSessions, runningSessionIds, unreadSessionIds),
    [runningSessionIds, unreadSessionIds, visibleSessions],
  );
  const hasOtherWorkspaceActivity = useMemo(
    () => projectActivity.hasActivityOutside(selectedProject),
    [projectActivity, selectedProject],
  );
  const visibleProjects = getProjectOrder([
    ...(selectedProject ? [selectedProject] : []),
    ...recentProjects,
    ...knownProjects,
  ]);

  useEffect(() => {
    if (!locateSessionRequest) return;
    const targetSession = visibleSessions.find((session) => session.id === locateSessionRequest.sessionId);
    if (!targetSession) return;
    const targetProject = sidebarProjectPath(targetSession);
    setCollapsedProjects((current) => {
      if (!current.has(targetProject)) return current;
      const next = new Set(current);
      next.delete(targetProject);
      return next;
    });
  }, [locateSessionRequest, visibleSessions]);

  const handleRemoveProject = useCallback(async () => {
    if (!projectPendingRemoval || projectRemovalBusy) return;

    setProjectRemovalBusy(true);
    setProjectRemovalError(null);
    const sessions = sessionsForProject(allSessions, projectPendingRemoval);
    try {
      for (const session of sessions) {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        onSessionDeleted?.(session.id);
      }

      await removeProject(projectPendingRemoval);

      removeSessions(sessions.map((session) => session.id));
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
  }, [allSessions, commitCustomPath, loadSessions, onSessionDeleted, projectPendingRemoval, projectRemovalBusy, removeProject, removeSessions, selectedProject, visibleProjects]);

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
              {t("sidebar.removeProjectDescription", { count: sessionsForProject(allSessions, projectPendingRemoval).length })}
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
              type="button"
              onClick={() => setSessionSearchOpen((open) => !open)}
              title={t("sidebar.toggleSessionSearch")}
              aria-label={t("sidebar.toggleSessionSearch")}
              aria-expanded={sessionSearchOpen}
              aria-controls="session-search-input"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionSearchOpen ? "var(--bg-selected)" : "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: sessionSearchOpen ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer", width: 32, height: 32, padding: 0,
                borderRadius: 7, flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
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

        {sessionSearchOpen && (
          <input
            id="session-search-input"
            type="search"
            autoFocus
            value={sessionSearchQuery}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setSessionSearchQuery("");
            }}
            style={{
              display: "block", width: "100%", minWidth: 0, height: 29,
              marginTop: 6, padding: "0 10px", border: "1px solid var(--border)",
              borderRadius: 7, background: "var(--bg)", color: "var(--text)", fontSize: 12,
            }}
          />
        )}

      </div>

      <SessionSearch
        open={sessionSearchOpen}
        query={sessionSearchQuery}
        refreshKey={refreshKey ?? null}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSelectSessionFromList}
      >
      {/* 项目目录与会话组成同一棵导航树，减少在目录选择器和会话列表之间切换。 */}
      <div data-session-scroll style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}>
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
          const projectSessions = sessionsForProject(visibleSessions, project);
          const active = project === selectedProject;
          const treeProps: SessionTreeSharedProps = {
            selectedSessionId,
            runningSessionIds,
            unreadSessionIds,
            pinnedSessionIds: pinnedIds,
            locateSessionRequest,
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
            <ProjectSection
              key={project}
              project={{
                path: project,
                name: projectName(project),
                active,
                collapsed,
                pinned: pinnedProjectPaths.has(project),
                isMobile,
                activity: showProjectActivity(projectActivity.get(project), t),
                sessions: projectSessions,
                sessionOrder,
              }}
              labels={{
                empty: t("sidebar.noSessions"),
                pin: t(pinnedProjectPaths.has(project) ? "sidebar.unpinProject" : "sidebar.pinProject", { name: projectName(project) }),
                remove: t("sidebar.removeProjectButton", { name: projectName(project) }),
                newSession: t("sidebar.newSessionTitle", { path: project }),
              }}
              actions={{
                onToggleCollapsed: () => {
                  void commitCustomPath(project);
                  setCollapsedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(project)) next.delete(project);
                    else next.add(project);
                    return next;
                  });
                },
                onMove: (source, target) => moveProject(source, target, visibleProjects),
                onTogglePinned: () => toggleProjectPinned(project),
                onRemove: () => {
                  setProjectRemovalError(null);
                  setProjectPendingRemoval(project);
                },
                onNewSession: () => handleNewSession(project),
              }}
              treeProps={treeProps}
            />
          );
        })}
      </div>
      </SessionSearch>

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
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal(selectedCwd ?? selectedCwdProp!)}
                title={t("terminal.open")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </ToolbarIconButton>
            )}
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
