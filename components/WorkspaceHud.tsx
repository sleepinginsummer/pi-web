"use client";

import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CountBadge } from "./DevServersShelf";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { stripAnsi } from "@/lib/ansi";
import { isDevServerActive, useDevServers } from "@/hooks/useDevServers";
import { isScheduledTaskPending, useScheduledTasks } from "@/hooks/useScheduledTasks";
import { useBackgroundCommands } from "@/hooks/useBackgroundCommands";
import { useI18n } from "@/hooks/useI18n";
import type { WorkspaceGitState } from "@/hooks/useWorkspaceGit";
import type { SessionArtifact } from "@/lib/session-artifacts";
import type { ExtensionWidgetItem, SessionInfo, WorktreeInfo } from "@/lib/types";
import { WorkspaceMcpSection } from "./WorkspaceMcpSection";

export interface ParsedTodoLine {
  text: string;
  status: "completed" | "in_progress" | "pending";
}

/** 从 rpiv-todos widget 的展示行里解析出结构化待办项（忽略首行汇总标题）。 */
export function parseTodoWidgetLines(widget: ExtensionWidgetItem | undefined): ParsedTodoLine[] {
  if (!widget || !Array.isArray(widget.lines) || widget.lines.length === 0) return [];
  const items: ParsedTodoLine[] = [];
  for (const raw of widget.lines) {
    const line = stripAnsi(raw).trim();
    if (!line || /^[●○]?\s*Todos\s*\(/i.test(line)) continue;
    const cleaned = line.replace(/^[├└]─\s*/, "");
    if (cleaned.startsWith("✓")) {
      items.push({ status: "completed", text: cleaned.slice(1).trim() });
    } else if (cleaned.startsWith("◐")) {
      items.push({ status: "in_progress", text: cleaned.slice(1).trim() });
    } else if (cleaned.startsWith("○")) {
      items.push({ status: "pending", text: cleaned.slice(1).trim() });
    } else {
      items.push({ status: "pending", text: cleaned });
    }
  }
  return items;
}

export interface WorkspaceHudSubagentItem {
  session: SessionInfo;
  running: boolean;
  isSide: boolean;
}

export interface WorkspaceHudProps {
  cwd: string | null | undefined;
  sessionId?: string | null;
  isNewSession: boolean;
  isMobile?: boolean;
  git: WorkspaceGitState;
  worktrees: WorktreeInfo[];
  artifacts: SessionArtifact[];
  /** 本会话内已成功执行的文件写入/编辑次数，用于在等行数编辑不改变 Git 统计时仍能触发展开。 */
  sessionMutationCount?: number;
  todoWidget?: ExtensionWidgetItem;
  subagents?: WorkspaceHudSubagentItem[];
  onSwitchBranch: (branch: string) => Promise<{ ok: boolean; error?: string }>;
  onSelectWorktree: (worktree: WorktreeInfo) => void;
  onCreateWorktree?: (branch: string) => Promise<void>;
  onOpenFileDiff: (filePath: string, fileName: string) => void;
  onOpenArtifactFile: (filePath: string, fileName: string) => void;
  onHideArtifact: (artifactId: string) => void;
  onDeleteArtifactFile: (artifact: SessionArtifact) => Promise<{ ok: boolean; trashed?: boolean; error?: string }>;
  onRefreshArtifacts?: () => void;
  onOpenServerPreview?: (serverId: string, label: string) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  /** 由 ChatWindow 提升的共享轮询状态，避免与左下角 DevServersShelf 重复轮询同一批接口。 */
  sharedDevServers?: ReturnType<typeof useDevServers>;
  sharedScheduled?: ReturnType<typeof useScheduledTasks>;
  sharedBackground?: ReturnType<typeof useBackgroundCommands>;
}

type SectionKey = "changes" | "artifacts" | "servers" | "tasks" | "todos" | "subagents";

function formatShortTime(ts: number | undefined): string {
  if (!ts) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return "刚刚";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

function formatNextRun(ms: number | null): string {
  if (!ms) return "";
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function worktreeDisplayName(worktree: WorktreeInfo, mainLabel: string): string {
  if (worktree.isMain) return `${getFileName(worktree.path)} (${mainLabel})`;
  return getFileName(worktree.path) || worktree.branch || worktree.path;
}

/**
 * 工作区：桌面为右上卡片，移动端通过 ChatWindow portal 复用到顶栏。
 * - 桌面保留整卡与分区折叠、活动自动展开及内部滚动；
 * - 移动端只在顶栏显示独立工作区按钮与可横向滚动的 Git 分支，点击才展开面板。
 */
export const WorkspaceHud = memo(function WorkspaceHud({
  cwd,
  sessionId,
  isNewSession,
  isMobile = false,
  git,
  worktrees,
  artifacts,
  sessionMutationCount = 0,
  todoWidget,
  subagents = [],
  onSwitchBranch,
  onSelectWorktree,
  onCreateWorktree,
  onOpenFileDiff,
  onOpenArtifactFile,
  onHideArtifact,
  onDeleteArtifactFile,
  onRefreshArtifacts,
  onOpenServerPreview,
  onOpenSubagent,
  sharedDevServers,
  sharedScheduled,
  sharedBackground,
}: WorkspaceHudProps) {
  const { t } = useI18n();
  const hudRef = useRef<HTMLDivElement | null>(null);
  const toolbarButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobilePanelId = useId();

  // 新会话默认极简收起；手机端入口固定在顶栏，只有用户点击才展开工作区。
  const [collapsed, setCollapsed] = useState<boolean>(() => (
    isNewSession
    || !(
      artifacts.length > 0
      || sessionMutationCount > 0
      || (git.status?.files?.length ?? 0) > 0
      || parseTodoWidgetLines(todoWidget).length > 0
    )
  ));
  const userToggledRef = useRef(false);
  const startedFromNewRef = useRef(isNewSession);
  const prevIsNewRef = useRef(isNewSession);
  const prevSessionIdRef = useRef<string | null | undefined>(sessionId);
  const baselineGitSigRef = useRef<string | null>(null);
  const baselineServerInstancesRef = useRef<Set<string> | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSubagentsSection, setShowSubagentsSection] = useState(true);
  const [openPicker, setOpenPicker] = useState<"branch" | "worktree" | null>(null);
  const [sections, setSections] = useState<Record<SectionKey, boolean>>({
    changes: false,
    artifacts: false,
    servers: false,
    tasks: false,
    todos: false,
    subagents: false,
  });
  const [copiedPath, setCopiedPath] = useState(false);
  const [creatingWt, setCreatingWt] = useState(false);
  const [newWtBranch, setNewWtBranch] = useState("");
  const [busyAction, setBusyAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionArtifact | null>(null);
  const [deletingArtifact, setDeletingArtifact] = useState(false);

  const localDevServers = useDevServers(sharedDevServers ? null : cwd);
  const localScheduled = useScheduledTasks(sharedScheduled ? null : cwd);
  const localBackground = useBackgroundCommands(sharedBackground ? null : cwd);
  const devServers = sharedDevServers ?? localDevServers;
  const scheduled = sharedScheduled ?? localScheduled;
  const background = sharedBackground ?? localBackground;

  // 点击外部收起更多菜单、内联切换框及移动端展开卡；Esc 优先关闭删除确认框
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (hudRef.current && !hudRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setOpenPicker(null);
        if (isMobile && mobileOpen && !pendingDelete) {
          setMobileOpen(false);
        }
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!pendingDelete && !menuOpen && !openPicker && !(isMobile && mobileOpen)) return;
      event.preventDefault();
      event.stopPropagation();
      if (pendingDelete) {
        setPendingDelete(null);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (openPicker) {
        setOpenPicker(null);
        return;
      }
      if (isMobile && mobileOpen) {
        setMobileOpen(false);
        toolbarButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isMobile, menuOpen, mobileOpen, openPicker, pendingDelete]);

  const toggleSection = useCallback((key: SectionKey) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const currentWorktree = useMemo(
    () => (cwd ? worktrees.find((wt) => wt.path === cwd) ?? null : null),
    [cwd, worktrees],
  );

  const isGit = Boolean(git.branches?.isGit || git.status?.isGitRepository || worktrees.length > 0);
  const currentBranch = git.branches?.currentBranch ?? currentWorktree?.branch ?? null;
  const branchList = git.branches?.branches ?? (currentBranch ? [currentBranch] : []);
  const isLinkedWorktree = Boolean(git.branches?.isWorktree || (currentWorktree && !currentWorktree.isMain));
  const currentWtShortName = currentWorktree
    ? (currentWorktree.isMain ? t("workspaceHud.mainRepo") : getFileName(currentWorktree.path))
    : (isLinkedWorktree && cwd ? getFileName(cwd) : t("workspaceHud.mainRepo"));

  const changedFiles = useMemo(() => git.status?.files ?? [], [git.status?.files]);
  const additions = git.status?.additions ?? 0;
  const deletions = git.status?.deletions ?? 0;

  // 服务器（单独一行）
  const activeServers = useMemo(
    () => (devServers.data?.servers ?? []).filter((sv) => isDevServerActive(sv)),
    [devServers.data?.servers],
  );
  const finishedServers = (devServers.data?.servers ?? []).filter((server) => server.status === "stopped" || server.status === "exited");
  // 启动失败仍留在正文，避免把需要处理的问题藏入已结束区域。
  const bodyServers = (devServers.data?.servers ?? []).filter((server) => server.status !== "stopped" && server.status !== "exited");
  const idleServerConfigs = useMemo(() => {
    const knownNames = new Set((devServers.data?.servers ?? []).map((server) => server.name));
    return (devServers.data?.configs ?? []).filter((config) => !knownNames.has(config.name));
  }, [devServers.data?.servers, devServers.data?.configs]);

  // 后台命令 & 定时任务（按当前会话筛选，与 DevServersShelf 口径一致）
  const sessionBgCommands = useMemo(() => {
    const list = background.data?.commands ?? [];
    if (!sessionId) return [];
    return list.filter((cmd) => cmd.sessionId === sessionId);
  }, [background.data?.commands, sessionId]);

  const sessionScheduledTasks = useMemo(() => {
    const list = scheduled.data?.tasks ?? [];
    if (!sessionId) return [];
    return list.filter((task) => task.sessionId === sessionId);
  }, [scheduled.data?.tasks, sessionId]);

  const activeBgCount = useMemo(
    () => sessionBgCommands.filter((cmd) => cmd.status === "running" || cmd.status === "stopping").length,
    [sessionBgCommands],
  );
  const pendingSchedCount = useMemo(
    () => sessionScheduledTasks.filter((task) => isScheduledTaskPending(task)).length,
    [sessionScheduledTasks],
  );
  const totalTaskEntries = sessionBgCommands.length + sessionScheduledTasks.length;
  const activeCommands = sessionBgCommands.filter((command) => command.status === "running" || command.status === "stopping");
  const finishedCommands = sessionBgCommands.filter((command) => command.status !== "running" && command.status !== "stopping");
  const pendingTasks = sessionScheduledTasks.filter(isScheduledTaskPending);
  const inactiveTasks = sessionScheduledTasks.filter((task) => !isScheduledTaskPending(task));
  const inactiveTaskCount = finishedCommands.length + inactiveTasks.length;

  // Todo 列表
  const todos = useMemo(() => parseTodoWidgetLines(todoWidget), [todoWidget]);
  const completedTodos = useMemo(() => todos.filter((item) => item.status === "completed").length, [todos]);

  // 子代理 & 侧聊
  const runningSubagents = useMemo(() => subagents.filter((item) => item.running).length, [subagents]);


  const gitChangeSig = useMemo(() => {
    if (!git.status) return null;
    const filesPart = changedFiles.map((f) => `${f.filePath}:${f.code}`).join(",");
    return `${changedFiles.length}:${additions}:${deletions}:${filesPart}`;
  }, [additions, changedFiles, deletions, git.status]);

  const activeServerInstanceKeys = useMemo(() => {
    if (!devServers.data) return null;
    return activeServers.map((sv) => `${sv.id}:${sv.startedAt}`);
  }, [activeServers, devServers.data]);

  const hasArtifacts = artifacts.length > 0;
  const hasSessionFileMutations = sessionMutationCount > 0;
  const hasTodos = todos.length > 0;
  // 后台命令与子代理本身已按 sessionId 隔离；项目级开发服务需按实例基线判重，避免旧服务器误触发新会话展开
  const hasSessionRunningWork = activeBgCount > 0 || runningSubagents > 0;

  // 新会话默认收起，并记录进入时的 Git 变更与项目级服务器实例基线；
  // 会话产生新产物/文件写入编辑/新 Git 变更/待办/新启动或重启服务器/会话任务后自动展开（不覆盖用户手动切换）
  useEffect(() => {
    const prevIsNew = prevIsNewRef.current;
    const prevSessionId = prevSessionIdRef.current;
    prevIsNewRef.current = isNewSession;
    prevSessionIdRef.current = sessionId;

    if (isNewSession) {
      if (!prevIsNew) {
        userToggledRef.current = false;
        startedFromNewRef.current = true;
        baselineGitSigRef.current = gitChangeSig;
        baselineServerInstancesRef.current = activeServerInstanceKeys ? new Set(activeServerInstanceKeys) : null;
        setCollapsed(true);
      } else {
        // 新会话尚未发送消息前，仓库已有的未提交变更与已运行项目服务器均作为基线，不触发自动展开
        if (gitChangeSig !== null) {
          baselineGitSigRef.current = gitChangeSig;
        }
        if (activeServerInstanceKeys !== null) {
          baselineServerInstancesRef.current = new Set(activeServerInstanceKeys);
        }
      }
      return;
    }

    if (prevIsNew) {
      // 新会话刚刚发出首条消息：保持收起，等待本会话真正产生新活动后再展开
      startedFromNewRef.current = true;
      if (baselineGitSigRef.current === null && gitChangeSig !== null) {
        baselineGitSigRef.current = gitChangeSig;
      }
      if (baselineServerInstancesRef.current === null && activeServerInstanceKeys !== null) {
        baselineServerInstancesRef.current = new Set(activeServerInstanceKeys);
      }
      return;
    }

    if (prevSessionId !== sessionId) {
      // 直接切换到另一条已有会话：按该会话是否已有活动决定默认形态
      userToggledRef.current = false;
      startedFromNewRef.current = false;
      baselineGitSigRef.current = null;
      baselineServerInstancesRef.current = null;
      setMobileOpen(false);
      setCollapsed(!(
        hasArtifacts
        || hasSessionFileMutations
        || changedFiles.length > 0
        || hasTodos
        || activeServers.length > 0
        || hasSessionRunningWork
      ));
    }
  }, [
    activeServerInstanceKeys,
    activeServers.length,
    changedFiles.length,
    gitChangeSig,
    hasArtifacts,
    hasSessionFileMutations,
    hasSessionRunningWork,
    hasTodos,
    isNewSession,
    sessionId,
  ]);

  useEffect(() => {
    if (isNewSession || userToggledRef.current || !collapsed) return;
    if (startedFromNewRef.current) {
      if (baselineGitSigRef.current === null && gitChangeSig !== null) {
        baselineGitSigRef.current = gitChangeSig;
      }
      if (baselineServerInstancesRef.current === null && activeServerInstanceKeys !== null) {
        baselineServerInstancesRef.current = new Set(activeServerInstanceKeys);
      }
      const hasNewGitChanges = gitChangeSig !== null
        && baselineGitSigRef.current !== null
        && gitChangeSig !== baselineGitSigRef.current;
      const hasNewActiveServer = activeServerInstanceKeys !== null
        && baselineServerInstancesRef.current !== null
        && activeServerInstanceKeys.some((key) => !baselineServerInstancesRef.current!.has(key));
      if (
        hasArtifacts
        || hasSessionFileMutations
        || hasTodos
        || hasSessionRunningWork
        || hasNewGitChanges
        || hasNewActiveServer
      ) {
        setCollapsed(false);
      }
    } else if (
      hasArtifacts
      || hasSessionFileMutations
      || changedFiles.length > 0
      || hasTodos
      || activeServers.length > 0
      || hasSessionRunningWork
    ) {
      setCollapsed(false);
    }
  }, [
    activeServerInstanceKeys,
    activeServers.length,
    changedFiles.length,
    collapsed,
    gitChangeSig,
    hasArtifacts,
    hasSessionFileMutations,
    hasSessionRunningWork,
    hasTodos,
    isNewSession,
  ]);

  const handleToggleCard = useCallback(() => {
    if (isMobile) {
      if (mobileOpen) {
        setMenuOpen(false);
        setOpenPicker(null);
        toolbarButtonRef.current?.focus();
      }
      setMobileOpen((value) => !value);
      return;
    }
    userToggledRef.current = true;
    setCollapsed((v) => !v);
  }, [isMobile, mobileOpen]);

  const handleExpandCollapsedCard = useCallback(() => {
    userToggledRef.current = true;
    setCollapsed(false);
  }, []);
  // 判断待删除产物是否大概率已被 Git 追踪（在仓库内且不在 untracked 列表中）
  const pendingDeleteGitTracked = useMemo(() => {
    if (!pendingDelete || pendingDelete.kind === "web") return false;
    const repoRoot = git.status?.repositoryRoot ?? git.branches?.projectRoot;
    if (!repoRoot) return false;
    const normalizedRoot = repoRoot.replace(/\/+$/, "");
    if (!pendingDelete.path.startsWith(`${normalizedRoot}/`)) return false;
    const statusEntry = changedFiles.find((f) => f.filePath === pendingDelete.path);
    return statusEntry?.status !== "untracked";
  }, [changedFiles, git.branches?.projectRoot, git.status?.repositoryRoot, pendingDelete]);

  if (!cwd) return null;

  const projectName = getFileName(git.branches?.projectRoot ?? cwd);
  const shortCwd = cwd.replace(/^\/Users\/[^/]+/, "~");

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(cwd);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1400);
    } catch {
      // ignore
    }
  };

  const handleOpenInExplorer = async () => {
    try {
      await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
    } catch {
      // ignore
    }
  };

  const handleSwitchBranch = async (branch: string) => {
    if (branch === currentBranch) {
      setOpenPicker(null);
      return;
    }
    setBusyAction(true);
    setActionError(null);
    const result = await onSwitchBranch(branch);
    setBusyAction(false);
    if (!result.ok) {
      setActionError(result.error ?? t("workspaceHud.branchSwitchFailed"));
      return;
    }
    setOpenPicker(null);
  };

  const handleCreateWorktree = async () => {
    const trimmed = newWtBranch.trim();
    if (!trimmed || !onCreateWorktree) return;
    setBusyAction(true);
    setActionError(null);
    try {
      await onCreateWorktree(trimmed);
      setNewWtBranch("");
      setCreatingWt(false);
      setOpenPicker(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmDeleteFile = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "web") {
      onHideArtifact(pendingDelete.id);
      setPendingDelete(null);
      return;
    }
    setDeletingArtifact(true);
    setActionError(null);
    const result = await onDeleteArtifactFile(pendingDelete);
    setDeletingArtifact(false);
    if (!result.ok) {
      setActionError(result.error ?? t("workspaceHud.deleteFailed"));
      return;
    }
    // 真实文件已删除，仅由服务端存在性状态过滤，不写入持久化隐藏集合（以免重新生成同名文件时仍被隐藏）
    setPendingDelete(null);
    git.refresh();
  };

  const renderServerRow = (server: (typeof activeServers)[number]) => {
    const active = isDevServerActive(server);
    const canStart = !active && !activeServers.some((current) => current.name === server.name) && devServers.data?.configs.some((config) => config.name === server.name);
    return (
      <div key={server.id} className="workspace-hud-row" onClick={() => onOpenServerPreview?.(server.id, server.name)}>
        <div className="workspace-hud-row-main">
          {active && <span className="workspace-hud-dot" aria-hidden="true" />}
          <span className="workspace-hud-row-title">{server.name}{server.port ? <span className="workspace-hud-row-sub"> :{server.port}</span> : null}</span>
        </div>
        <div style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
          {onOpenServerPreview && <button type="button" className={`workspace-hud-mini-btn${active ? " is-primary" : ""}`} onClick={(event) => { event.stopPropagation(); onOpenServerPreview(server.id, server.name); }}>{t("workspaceHud.preview")}</button>}
          {active && server.managed && <button type="button" disabled={devServers.pending.has(server.id)} className="workspace-hud-mini-btn is-danger" onClick={(event) => { event.stopPropagation(); void devServers.stop(server.id); }}>{t("workspaceHud.stop")}</button>}
          {canStart && <button type="button" disabled={devServers.pending.has(`start:${server.name}`)} className="workspace-hud-mini-btn" onClick={(event) => { event.stopPropagation(); void devServers.start(server.name); }}>{t("workspaceHud.start")}</button>}
        </div>
      </div>
    );
  };

  const renderCommandRow = (command: (typeof sessionBgCommands)[number]) => {
    const running = command.status === "running" || command.status === "stopping";
    return (
      <div key={command.id} className="workspace-hud-row" title={command.command}>
        <div className="workspace-hud-row-main">
          {running && <span className="workspace-hud-dot" aria-hidden="true" />}
          <span className="workspace-hud-row-title" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{command.label ?? command.command}</span>
        </div>
        <button type="button" disabled={background.pending.has(command.id)} className={`workspace-hud-mini-btn${running ? " is-danger" : ""}`} onClick={() => void background.act(command.id, running ? "stop" : "dismiss")}>
          {running ? t("workspaceHud.stop") : t("workspaceHud.dismiss")}
        </button>
      </div>
    );
  };

  const renderScheduledRow = (task: (typeof sessionScheduledTasks)[number]) => {
    const pending = isScheduledTaskPending(task);
    return (
      <div key={task.id} className="workspace-hud-row" title={task.prompt}>
        <div className="workspace-hud-row-main"><span className="workspace-hud-row-title">{task.name}</span></div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {task.nextRunAt !== null && <span className="workspace-hud-row-sub">{formatNextRun(task.nextRunAt)}</span>}
          <button type="button" disabled={scheduled.pending.has(task.id)} className="workspace-hud-mini-btn" onClick={() => void scheduled.act(task.id, pending ? "pause" : "resume")}>
            {pending ? t("workspaceHud.pause") : t("workspaceHud.resume")}
          </button>
        </div>
      </div>
    );
  };

  const hasAnyActiveIndicator = activeServers.length > 0 || activeBgCount > 0 || runningSubagents > 0;


  const isExpandedCard = isMobile ? mobileOpen : !collapsed;

  return (
    <>
      <div ref={hudRef} className={isMobile ? "workspace-hud-toolbar" : `workspace-hud-anchor${isExpandedCard ? " is-expanded" : ""}`}>
        {isMobile && (
          <>
            <button
              ref={toolbarButtonRef}
              type="button"
              className="workspace-hud-toolbar-trigger"
              aria-expanded={mobileOpen}
              aria-controls={mobileOpen ? mobilePanelId : undefined}
              aria-label={t("workspaceHud.button")}
              title={t(mobileOpen ? "workspaceHud.collapseCard" : "workspaceHud.expandCard")}
              onClick={handleToggleCard}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M15 9v12" /></svg>
              <span className="workspace-hud-toolbar-trigger-label">{t("workspaceHud.button")}</span>
              {hasAnyActiveIndicator && <span className="workspace-hud-dot" aria-hidden="true" />}
            </button>
            {isGit && currentBranch && (
              <div className="workspace-hud-toolbar-git">
                <span aria-hidden="true">⎇</span>
                <div className="workspace-hud-toolbar-branch" tabIndex={0} title={currentBranch} aria-label={`${t("workspaceHud.gitBranch")}: ${currentBranch}`}>
                  {currentBranch}
                </div>
              </div>
            )}
          </>
        )}
        {(!isMobile || mobileOpen) && (
          <>
        <aside id={isMobile ? mobilePanelId : undefined} className="workspace-hud-card" aria-label={t("workspaceHud.title")}>
          {/* 顶部标题行 */}
          <div className="workspace-hud-header">
            <button
              type="button"
              className="workspace-hud-title-btn"
              onClick={handleToggleCard}
              title={isExpandedCard ? t("workspaceHud.collapseCard") : t("workspaceHud.expandCard")}
            >
              <span className="workspace-hud-project">{projectName}</span>
            </button>
            <div className="workspace-hud-actions">
              <button
                type="button"
                className="workspace-hud-icon-btn"
                onClick={handleToggleCard}
                title={isExpandedCard ? t("workspaceHud.collapseCard") : t("workspaceHud.expandCard")}
                aria-label={isExpandedCard ? t("workspaceHud.collapseCard") : t("workspaceHud.expandCard")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {isExpandedCard ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
                </svg>
              </button>
              <button
                type="button"
                className={`workspace-hud-icon-btn${menuOpen ? " is-active" : ""}`}
                onClick={() => setMenuOpen((v) => !v)}
                title={t("workspaceHud.moreActions")}
                aria-label={t("workspaceHud.moreActions")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                  <circle cx="5" cy="12" r="1" />
                </svg>
              </button>

            </div>
          </div>

          {/* 极简收起态：Git 分支与 Worktree 分成独立两行 */}
          {!isExpandedCard ? (
            <div
              className="workspace-hud-collapsed"
              role="button"
              tabIndex={0}
              onClick={handleExpandCollapsedCard}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleExpandCollapsedCard();
                }
              }}
              title={t("workspaceHud.expandCard")}
            >
              {!isGit ? (
                <div className="workspace-hud-collapsed-row">
                  <span className="workspace-hud-collapsed-left">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span className="composer-context-mono">{shortCwd}</span>
                  </span>
                </div>
              ) : (
                <>
                  <div className="workspace-hud-collapsed-row">
                    <span className="workspace-hud-collapsed-left">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <line x1="6" y1="3" x2="6" y2="15" />
                        <circle cx="18" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      <span>{t("workspaceHud.gitBranch")}</span>
                    </span>
                    <span className="composer-context-mono" style={{ color: "var(--text)", fontWeight: 500 }}>
                      {currentBranch ?? "HEAD"}
                    </span>
                  </div>
                  {(worktrees.length > 0 || isLinkedWorktree) && (
                    <div className="workspace-hud-collapsed-row">
                      <span className="workspace-hud-collapsed-left">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--accent)" }} aria-hidden="true">
                          <rect x="3" y="3" width="7" height="7" rx="1.5" />
                          <rect x="14" y="3" width="7" height="7" rx="1.5" />
                          <rect x="14" y="14" width="7" height="7" rx="1.5" />
                          <path d="M6.5 10v4a3 3 0 0 0 3 3H14" />
                        </svg>
                        <span>Worktree</span>
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                        <span className="workspace-hud-wt-tag">{currentWtShortName}</span>
                        {worktrees.length > 0 && (
                          <span className="workspace-hud-row-sub">({worktrees.length})</span>
                        )}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            /* 展开清单态（整卡内部可滚 + 每个列表独立可滚） */
            <div className="workspace-hud-body">
              {actionError && (
                <div className="composer-context-pop-error" style={{ margin: "4px 10px 6px" }}>
                  {actionError}
                </div>
              )}

              {/* ① 项目路径 + Git 分支（直点名称切换）+ Worktree（直点名称切换） */}
              <div className="workspace-hud-env">
                <div className="workspace-hud-env-row">
                  <div className="workspace-hud-path" title={cwd}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }} aria-hidden="true">
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span>{shortCwd}</span>
                  </div>
                  <div style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                    <button type="button" className="workspace-hud-mini-btn" onClick={() => void handleCopyPath()}>
                      {copiedPath ? t("workspaceHud.copied") : t("workspaceHud.copy")}
                    </button>
                    <button type="button" className="workspace-hud-mini-btn" onClick={() => void handleOpenInExplorer()}>
                      {t("workspaceHud.openFolder")}
                    </button>
                  </div>
                </div>

                {isGit && currentBranch && (
                  <>
                    <button
                      type="button"
                      disabled={git.branches?.canSwitch === false}
                      className={`workspace-hud-trigger${openPicker === "branch" ? " is-open" : ""}`}
                      onClick={() => {
                        if (git.branches?.canSwitch === false) return;
                        setActionError(null);
                        setOpenPicker((p) => (p === "branch" ? null : "branch"));
                      }}
                      title={git.branches?.canSwitch === false ? currentBranch : t("workspaceHud.switchBranch")}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 0 1-9 9" />
                        </svg>
                        <span style={{ color: "var(--text-dim)", fontSize: 11.5, flexShrink: 0 }}>{t("workspaceHud.branchShort")}</span>
                        <span className="composer-context-mono" style={{ color: "var(--text)", fontWeight: 500 }}>
                          {currentBranch}
                        </span>
                      </span>
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }} aria-hidden="true">
                        {openPicker === "branch" ? "▴" : "▾"}
                      </span>
                    </button>

                    {openPicker === "branch" && (
                      <div className="workspace-hud-picker">
                        <div className="composer-context-pop-header">{t("workspaceHud.switchBranchHeading")}</div>
                        {branchList.map((br) => {
                          const isCurrent = br === currentBranch;
                          return (
                            <button
                              key={br}
                              type="button"
                              disabled={busyAction}
                              className={`composer-context-pop-row${isCurrent ? " is-current" : ""}`}
                              onClick={() => void handleSwitchBranch(br)}
                            >
                              <span className="composer-context-pop-row-main">
                                <span aria-hidden="true">{isCurrent ? "●" : "○"}</span>
                                <span className="composer-context-mono">{br}</span>
                              </span>
                              <span className="composer-context-pop-row-sub">
                                {isCurrent ? t("workspaceHud.current") : t("workspaceHud.switchAction")}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Worktree：直接点击名称即可展开切换/新建 */}
                    {(worktrees.length > 0 || onCreateWorktree) && (
                      <>
                        <button
                          type="button"
                          className={`workspace-hud-trigger${openPicker === "worktree" ? " is-open" : ""}`}
                          onClick={() => {
                            setActionError(null);
                            setOpenPicker((p) => (p === "worktree" ? null : "worktree"));
                          }}
                          title={t("workspaceHud.selectWorktree")}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true">
                              <rect x="3" y="3" width="7" height="7" rx="1.5" />
                              <rect x="14" y="3" width="7" height="7" rx="1.5" />
                              <rect x="14" y="14" width="7" height="7" rx="1.5" />
                              <path d="M6.5 10v4a3 3 0 0 0 3 3H14" />
                            </svg>
                            <span style={{ color: "var(--text-dim)", fontSize: 11.5, flexShrink: 0 }}>Worktree</span>
                            <span className="workspace-hud-wt-tag">{currentWtShortName}</span>
                            {worktrees.length > 0 && (
                              <span className="workspace-hud-row-sub">({worktrees.length})</span>
                            )}
                          </span>
                          <span style={{ color: "var(--text-dim)", fontSize: 11 }} aria-hidden="true">
                            {openPicker === "worktree" ? "▴" : "▾"}
                          </span>
                        </button>

                        {openPicker === "worktree" && (
                          <div className="workspace-hud-picker">
                            <div className="composer-context-pop-header">
                              {isNewSession
                                ? t("workspaceHud.worktreeNewSessionHint")
                                : t("workspaceHud.worktreeExistingSessionHint")}
                            </div>
                            {worktrees.map((wt) => {
                              const isCurrent = wt.path === cwd;
                              const branchDisplay = wt.upstreamDisplayBranch ?? wt.upstreamBranch ?? wt.branch ?? "";
                              return (
                                <button
                                  key={wt.path}
                                  type="button"
                                  disabled={busyAction}
                                  className={`composer-context-pop-row${isCurrent ? " is-current" : ""}`}
                                  onClick={() => {
                                    setOpenPicker(null);
                                    if (!isCurrent) onSelectWorktree(wt);
                                  }}
                                >
                                  <span className="composer-context-pop-row-main">
                                    <span aria-hidden="true">{isCurrent ? "●" : "○"}</span>
                                    <span className="composer-context-pop-name">
                                      {worktreeDisplayName(wt, t("workspaceHud.mainRepo"))}
                                    </span>
                                    {branchDisplay && (
                                      <span className="composer-context-pop-tag">{branchDisplay}</span>
                                    )}
                                  </span>
                                  <span className={`composer-context-pop-row-sub${!isCurrent && !isNewSession ? " is-accent" : ""}`}>
                                    {isCurrent
                                      ? t("workspaceHud.current")
                                      : isNewSession
                                        ? t("workspaceHud.switchAction")
                                        : t("workspaceHud.openNewSessionShort")}
                                  </span>
                                </button>
                              );
                            })}

                            {onCreateWorktree && (
                              creatingWt ? (
                                <div className="composer-context-create-box">
                                  <input
                                    type="text"
                                    className="composer-context-create-input"
                                    value={newWtBranch}
                                    onChange={(e) => setNewWtBranch(e.target.value)}
                                    placeholder={t("workspaceHud.newWorktreePlaceholder")}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        void handleCreateWorktree();
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    disabled={busyAction || !newWtBranch.trim()}
                                    className="composer-context-create-btn"
                                    onClick={() => void handleCreateWorktree()}
                                  >
                                    {busyAction ? t("workspaceHud.creating") : t("workspaceHud.createNow")}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="composer-context-pop-row"
                                  style={{ color: "var(--accent)", fontWeight: 500 }}
                                  onClick={() => setCreatingWt(true)}
                                >
                                  <span>+ {t("workspaceHud.createWorktreeToggle")}…</span>
                                </button>
                              )
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              {/* 空栏目不占位；停止记录保留在默认关闭的分组中，便于查看和恢复。 */}
              {isGit && changedFiles.length > 0 && (
                <div className="workspace-hud-section">
                  <button type="button" className="workspace-hud-sec-header" onClick={() => toggleSection("changes")}>
                    <span className="workspace-hud-sec-left">
                      <span aria-hidden="true">{sections.changes ? "▾" : "▸"}</span>
                      <span>{t("workspaceHud.changedFiles")}</span>
                      <span className="workspace-hud-count">{changedFiles.length}</span>
                    </span>
                    <span className="workspace-hud-diff">
                      {additions > 0 && <span className="workspace-hud-diff-add">+{additions.toLocaleString()}</span>}
                      {deletions > 0 && <span className="workspace-hud-diff-del">-{deletions.toLocaleString()}</span>}
                      {additions === 0 && deletions === 0 && (
                        <span className="workspace-hud-row-sub">{t("workspaceHud.clean")}</span>
                      )}
                    </span>
                  </button>
                  {sections.changes && (
                    <div className="workspace-hud-sec-list">
                      {changedFiles.length === 0 ? (
                        <div className="workspace-hud-row-sub" style={{ padding: "8px", textAlign: "center" }}>
                          {t("workspaceHud.noChanges")}
                        </div>
                      ) : (
                        changedFiles.map((file) => {
                          const fileName = getFileName(file.filePath);
                          const rel = getRelativeFilePath(file.filePath, cwd);
                          const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
                          return (
                            <div
                              key={file.filePath}
                              className="workspace-hud-row"
                              role="button"
                              tabIndex={0}
                              onClick={() => onOpenFileDiff(file.filePath, fileName)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onOpenFileDiff(file.filePath, fileName);
                                }
                              }}
                              title={file.filePath}
                            >
                              <div className="workspace-hud-row-main">
                                <span className={`workspace-hud-git-code workspace-hud-git-${file.code}`}>{file.code}</span>
                                <span className="workspace-hud-row-title">{fileName}</span>
                                {dir && <span className="workspace-hud-row-sub">{dir}</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ③ 本会话产物（支持预览与二次确认删除） */}
              {hasArtifacts && <div className="workspace-hud-section">
                <button type="button" className="workspace-hud-sec-header" aria-label={`${t("workspaceHud.artifacts")} ${artifacts.length}`} title={t("workspaceHud.artifacts")} aria-expanded={sections.artifacts} onClick={() => toggleSection("artifacts")}>
                  <span className="workspace-hud-sec-left">
                    <span aria-hidden="true">{sections.artifacts ? "▾" : "▸"}</span>
                    <span>{t("workspaceHud.artifacts")}</span>
                    <span className="workspace-hud-count">{artifacts.length}</span>
                  </span>
                </button>
                {sections.artifacts && (
                  <div className="workspace-hud-sec-list">
                    {artifacts.length === 0 ? (
                      <div className="workspace-hud-row-sub" style={{ padding: "8px", textAlign: "center" }}>
                        {t("workspaceHud.noArtifacts")}
                      </div>
                    ) : (
                      artifacts.map((item) => (
                        <div
                          key={item.id}
                          className="workspace-hud-row"
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (item.kind === "web") {
                              window.open(item.path, "_blank", "noopener,noreferrer");
                            } else {
                              onOpenArtifactFile(item.path, item.name);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              if (item.kind === "web") {
                                window.open(item.path, "_blank", "noopener,noreferrer");
                              } else {
                                onOpenArtifactFile(item.path, item.name);
                              }
                            }
                          }}
                          title={item.path}
                        >
                          <div className="workspace-hud-row-main">
                            <span aria-hidden="true" style={{ fontSize: 12, flexShrink: 0 }}>
                              {item.kind === "web" || item.kind === "html" ? "🌐" : item.kind === "image" ? "🖼" : item.kind === "json" ? "{}" : "📄"}
                            </span>
                            <span className="workspace-hud-row-title">{item.name}</span>
                          </div>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            {item.timestamp && (
                              <span className="workspace-hud-row-sub">{formatShortTime(item.timestamp)}</span>
                            )}
                            <button
                              type="button"
                              className="workspace-hud-del-btn"
                              aria-label={t("workspaceHud.deleteArtifactAria", { name: item.name })}
                              title={t("workspaceHud.deleteArtifact")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setActionError(null);
                                setPendingDelete(item);
                              }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>}

              {/* ④ 服务器（单独一行） */}
              {bodyServers.length + finishedServers.length > 0 && <div className="workspace-hud-section">
                <button type="button" className="workspace-hud-sec-header" aria-label={`${t("workspaceHud.servers")} ${activeServers.length}`} title={t("workspaceHud.servers")} aria-expanded={sections.servers} onClick={() => toggleSection("servers")}>
                  <span className="workspace-hud-sec-left">
                    <span aria-hidden="true">{sections.servers ? "▾" : "▸"}</span>
                    <span>{t("workspaceHud.servers")}</span>
                    <span className="workspace-hud-count">{activeServers.length}</span>
                  </span>
                </button>
                {sections.servers && (
                  <div className="workspace-hud-sec-list">
                    {bodyServers.map(renderServerRow)}
                    {idleServerConfigs.map((config) => (
                      <div key={config.name} className="workspace-hud-row">
                        <div className="workspace-hud-row-main">
                          <span className="workspace-hud-row-title" style={{ color: "var(--text-muted)" }}>{config.name}{config.port ? <span className="workspace-hud-row-sub"> :{config.port}</span> : null}</span>
                        </div>
                        <button type="button" disabled={devServers.pending.has(`start:${config.name}`)} className="workspace-hud-mini-btn" onClick={() => void devServers.start(config.name)}>{t("workspaceHud.start")}</button>
                      </div>
                    ))}
                    {finishedServers.length > 0 && (
                      <details className="finished-tasks" data-workspace-finished="servers">
                        <summary className="workspace-hud-row-sub" style={{ padding: "6px 7px" }}>{t("servers.finishedSection", { count: finishedServers.length })}</summary>
                        {finishedServers.map(renderServerRow)}
                      </details>
                    )}
                  </div>
                )}
              </div>}

              {/* ⑤ 后台命令 & 定时任务 */}
              {(totalTaskEntries > 0) && <div className="workspace-hud-section">
                <button type="button" className="workspace-hud-sec-header" aria-label={`${t("workspaceHud.tasks")} · ${t("workspaceHud.schedCount", { count: pendingSchedCount })} · ${t("workspaceHud.bgCount", { count: activeBgCount })}`} title={t("workspaceHud.tasks")} aria-expanded={sections.tasks} onClick={() => toggleSection("tasks")}>
                  <span className="workspace-hud-sec-left">
                    <span aria-hidden="true">{sections.tasks ? "▾" : "▸"}</span>
                    <span>{t("workspaceHud.tasks")}</span>
                    {pendingSchedCount > 0 && (
                      <CountBadge count={pendingSchedCount} icon={<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>} />
                    )}
                    {activeBgCount > 0 && (
                      <CountBadge count={activeBgCount} icon={<path d="M5 7l5 5-5 5M12 17h7" />} />
                    )}
                  </span>
                </button>
                {sections.tasks && (
                  <div className="workspace-hud-sec-list">
                    {activeCommands.map(renderCommandRow)}
                    {pendingTasks.map(renderScheduledRow)}
                    {inactiveTaskCount > 0 && (
                      <details className="finished-tasks" data-workspace-finished="tasks">
                        <summary className="workspace-hud-row-sub" style={{ padding: "6px 7px" }}>{t("tasks.inactiveSection", { count: inactiveTaskCount })}</summary>
                        {finishedCommands.map(renderCommandRow)}
                        {inactiveTasks.map(renderScheduledRow)}
                      </details>
                    )}
                  </div>
                )}
              </div>}

              <WorkspaceMcpSection key={sessionId ?? "new"} sessionId={sessionId} />
              {/* ⑥ Todo 列表 */}
              {hasTodos && <div className="workspace-hud-section">
                <button type="button" className="workspace-hud-sec-header" onClick={() => toggleSection("todos")}>
                  <span className="workspace-hud-sec-left">
                    <span aria-hidden="true">{sections.todos ? "▾" : "▸"}</span>
                    <span>{t("workspaceHud.todos")}</span>
                    <span className="workspace-hud-count">
                      {todos.length > 0 ? `${completedTodos}/${todos.length}` : "0"}
                    </span>
                  </span>
                  <span className={`workspace-hud-row-sub workspace-hud-todo-progress${completedTodos === todos.length ? " is-complete" : ""}`}>
                    {todos.length > 0 ? `${Math.round((completedTodos / todos.length) * 100)}%` : t("workspaceHud.empty")}
                  </span>
                </button>
                {sections.todos && (
                  <div className="workspace-hud-sec-list">
                    {todos.length === 0 ? (
                      <div className="workspace-hud-row-sub" style={{ padding: "8px", textAlign: "center" }}>
                        {t("workspaceHud.noTodos")}
                      </div>
                    ) : (
                      todos.map((item, idx) => (
                        <div key={`${idx}:${item.text}`} className="workspace-hud-row" style={{ cursor: "default", alignItems: "flex-start" }}>
                          <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 12, color: item.status === "completed" ? "#16a34a" : item.status === "in_progress" ? "var(--accent)" : "var(--text-dim)" }}>
                            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              fontSize: 12,
                              color: item.status === "completed" ? "var(--text-dim)" : "var(--text)",
                              textDecoration: item.status === "completed" ? "line-through" : undefined,
                              lineHeight: 1.45,
                            }}
                          >
                            {item.text}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>}

              {/* ⑦ 子代理 & 侧聊（可在 ··· 菜单中开关） */}
              {showSubagentsSection && subagents.length > 0 && (
                <div className="workspace-hud-section">
                  <button type="button" className="workspace-hud-sec-header" onClick={() => toggleSection("subagents")}>
                    <span className="workspace-hud-sec-left">
                      <span aria-hidden="true">{sections.subagents ? "▾" : "▸"}</span>
                      <span>{t("workspaceHud.subagents")}</span>
                      <span className="workspace-hud-count">{subagents.length}</span>
                    </span>
                    <span className="workspace-hud-row-sub" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {runningSubagents > 0 && <span className="workspace-hud-dot" aria-hidden="true" />}
                      {runningSubagents > 0
                        ? t("workspaceHud.runningCount", { count: runningSubagents })
                        : t("workspaceHud.done")}
                    </span>
                  </button>
                  {sections.subagents && (
                    <div className="workspace-hud-sec-list">
                      {subagents.map((item) => {
                        const label = item.session.name || item.session.firstMessage || item.session.id.slice(0, 8);
                        return (
                          <div
                            key={item.session.id}
                            className="workspace-hud-row"
                            onClick={() => onOpenSubagent?.(item.session.id, label)}
                          >
                            <div className="workspace-hud-row-main">
                              {item.running ? (
                                <span className="workspace-hud-dot" aria-hidden="true" />
                              ) : (
                                <span style={{ color: "var(--text-dim)", fontSize: 11 }} aria-hidden="true">✓</span>
                              )}
                              <span className="workspace-hud-row-title">{label}</span>
                            </div>
                            <span className="workspace-hud-row-sub">
                              {item.isSide ? t("workspaceHud.sideChat") : t("workspaceHud.subagent")}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* 更多菜单放在裁切容器外（.workspace-hud-anchor 内），极简收起态也不会裁掉“刷新全部” */}
        {menuOpen && (
          <div className="workspace-hud-menu" role="menu">
            <button
              type="button"
              className="composer-context-pop-toggle"
              onClick={() => setShowSubagentsSection((v) => !v)}
            >
              <span>{t("workspaceHud.subagents")}</span>
              <span className={`composer-context-switch${showSubagentsSection ? " is-on" : ""}`} aria-hidden="true" />
            </button>
            <div className="composer-context-pop-sep" />
            <button
              type="button"
              className="composer-context-pop-row"
              onClick={() => {
                git.refresh();
                onRefreshArtifacts?.();
                void devServers.refresh();
                void scheduled.refresh();
                void background.refresh();
                setMenuOpen(false);
              }}
            >
              <span>{t("workspaceHud.refreshAll")}</span>
            </button>
          </div>
        )}
          </>
        )}
      </div>

      {/* 会话产物删除二次确认弹窗 */}
      {pendingDelete && (
        <div
          className="workspace-hud-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t("workspaceHud.deleteConfirmTitle")}
          onClick={(event) => {
            if (event.target === event.currentTarget && !deletingArtifact) {
              setPendingDelete(null);
            }
          }}
        >
          <div className="workspace-hud-modal">
            <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)" }}>
              {t("workspaceHud.deleteConfirmTitle")}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
              {pendingDelete.kind === "web"
                ? t("workspaceHud.deleteWebConfirmDesc", { name: pendingDelete.name })
                : t("workspaceHud.deleteFileConfirmDesc", { name: pendingDelete.name })}
            </div>
            <div className="workspace-hud-modal-path">{pendingDelete.path}</div>
            {pendingDeleteGitTracked && (
              <div className="workspace-hud-modal-warn">
                {t("workspaceHud.deleteGitTrackedWarn")}
              </div>
            )}
            <div className="workspace-hud-modal-actions">
              <button
                type="button"
                disabled={deletingArtifact}
                className="workspace-hud-mini-btn"
                style={{ padding: "5px 11px", fontSize: 12 }}
                onClick={() => setPendingDelete(null)}
              >
                {t("workspaceHud.cancel")}
              </button>
              {pendingDelete.kind !== "web" && (
                <button
                  type="button"
                  disabled={deletingArtifact}
                  className="workspace-hud-mini-btn"
                  style={{ padding: "5px 11px", fontSize: 12 }}
                  onClick={() => {
                    onHideArtifact(pendingDelete.id);
                    setPendingDelete(null);
                  }}
                >
                  {t("workspaceHud.hideFromListOnly")}
                </button>
              )}
              <button
                type="button"
                disabled={deletingArtifact}
                className="workspace-hud-mini-btn is-danger"
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  background: "#dc2626",
                  color: "#fff",
                  borderColor: "transparent",
                }}
                onClick={() => void handleConfirmDeleteFile()}
              >
                {deletingArtifact
                  ? t("workspaceHud.deleting")
                  : pendingDelete.kind === "web"
                    ? t("workspaceHud.removeFromList")
                    : t("workspaceHud.deleteFileConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
