"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import type { WorkspaceGitState } from "@/hooks/useWorkspaceGit";
import type { WorktreeInfo } from "@/lib/types";

export interface ComposerContextPillProps {
  cwd?: string | null;
  isNewSession: boolean;
  git?: WorkspaceGitState | null;
  worktrees?: WorktreeInfo[];
  onSwitchBranch?: (branch: string) => Promise<{ ok: boolean; error?: string }>;
  onSelectWorktree?: (worktree: WorktreeInfo) => void;
  onCreateWorktree?: (branch: string) => Promise<void>;
  compact?: boolean;
}

function worktreeLabel(worktree: WorktreeInfo): string {
  if (worktree.isMain) return getFileName(worktree.path);
  return getFileName(worktree.path) || worktree.branch || worktree.path;
}

function worktreeBranchDisplay(worktree: WorktreeInfo): string {
  return worktree.upstreamDisplayBranch ?? worktree.upstreamBranch ?? worktree.branch ?? "";
}

/**
 * 输入框左上角毛玻璃上下文胶囊：文件夹 + 可切换 Git 分支 + 可选择/新建 Worktree。
 * 与右侧 ComposerTopUtilities 处于同一水平排并复用同款毛玻璃质感。
 */
export const ComposerContextPill = memo(function ComposerContextPill({
  cwd,
  isNewSession,
  git,
  worktrees = [],
  onSwitchBranch,
  onSelectWorktree,
  onCreateWorktree,
  compact = false,
}: ComposerContextPillProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openMenu, setOpenMenu] = useState<"branch" | "worktree" | null>(null);
  const [copied, setCopied] = useState(false);
  const [createToggle, setCreateToggle] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
        setActionError(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setActionError(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  if (!cwd) return null;

  const folderName = getFileName(cwd);
  const currentWorktree = worktrees.find((w) => w.path === cwd) ?? null;
  const isGit = Boolean(git?.branches?.isGit || worktrees.length > 0);
  const currentBranch = git?.branches?.currentBranch ?? currentWorktree?.branch ?? null;
  const branchList = git?.branches?.branches ?? (currentBranch ? [currentBranch] : []);
  const isLinkedWorktree = Boolean(git?.branches?.isWorktree || (currentWorktree && !currentWorktree.isMain));
  const showWorktreeSelector = isGit && (worktrees.length > 0 || Boolean(onCreateWorktree));

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(cwd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // 非 HTTPS 环境剪贴板不可用时静默忽略
    }
  };

  const handleBranchPick = async (branch: string) => {
    if (branch === currentBranch || !onSwitchBranch) {
      setOpenMenu(null);
      return;
    }
    setMutating(true);
    setActionError(null);
    const result = await onSwitchBranch(branch);
    setMutating(false);
    if (!result.ok) {
      setActionError(result.error ?? t("workspaceHud.branchSwitchFailed"));
      return;
    }
    setOpenMenu(null);
  };

  const handleCreateWorktree = async () => {
    const trimmed = newBranchName.trim();
    if (!trimmed || !onCreateWorktree) return;
    setMutating(true);
    setActionError(null);
    try {
      await onCreateWorktree(trimmed);
      setNewBranchName("");
      setCreateToggle(false);
      setOpenMenu(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  };

  return (
    <div ref={rootRef} className="composer-context-pill" role="group" aria-label={t("workspaceHud.composerBarLabel")}>
      {/* 文件夹 */}
      <button
        type="button"
        className="composer-context-item"
        onClick={() => void handleCopyPath()}
        title={copied ? t("workspaceHud.copied") : `${cwd} (${t("workspaceHud.clickToCopy")})`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        <span className="composer-context-label">{copied ? t("workspaceHud.copied") : folderName}</span>
      </button>

      {/* Git 分支（直接点击名称切换） */}
      {isGit && currentBranch && (
        <>
          <span className="composer-context-sep" aria-hidden="true" />
          <div className="composer-context-menu-wrap">
            <button
              type="button"
              disabled={git?.branches?.canSwitch === false}
              className={`composer-context-item${openMenu === "branch" ? " is-open" : ""}`}
              aria-expanded={openMenu === "branch"}
              aria-label={t("workspaceHud.switchBranch")}
              title={git?.branches?.canSwitch === false ? currentBranch : t("workspaceHud.switchBranchTitle", { branch: currentBranch })}
              onClick={() => {
                if (git?.branches?.canSwitch === false) return;
                setActionError(null);
                setOpenMenu((prev) => (prev === "branch" ? null : "branch"));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              <span className="composer-context-mono">{currentBranch}</span>
              <span className="composer-context-caret" aria-hidden="true">▾</span>
            </button>

            {openMenu === "branch" && (
              <div className="composer-context-popover" role="menu">
                <div className="composer-context-pop-header">{t("workspaceHud.switchBranchHeading")}</div>
                {actionError && <div className="composer-context-pop-error">{actionError}</div>}
                <div className="composer-context-pop-list">
                  {branchList.map((branch) => {
                    const isCurrent = branch === currentBranch;
                    return (
                      <button
                        key={branch}
                        type="button"
                        disabled={mutating || !onSwitchBranch}
                        className={`composer-context-pop-row${isCurrent ? " is-current" : ""}`}
                        onClick={() => void handleBranchPick(branch)}
                      >
                        <span className="composer-context-pop-row-main">
                          <span aria-hidden="true">{isCurrent ? "●" : "○"}</span>
                          <span className="composer-context-mono">{branch}</span>
                        </span>
                        <span className="composer-context-pop-row-sub">
                          {isCurrent ? t("workspaceHud.current") : t("workspaceHud.switchAction")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Worktree（直接点击名称切换或新建） */}
      {showWorktreeSelector && !compact && (
        <>
          <span className="composer-context-sep" aria-hidden="true" />
          <div className="composer-context-menu-wrap">
            <button
              type="button"
              className={`composer-context-item${openMenu === "worktree" ? " is-open" : ""}${isLinkedWorktree ? " is-wt" : ""}`}
              aria-expanded={openMenu === "worktree"}
              aria-label={t("workspaceHud.selectWorktree")}
              title={t("workspaceHud.selectWorktree")}
              onClick={() => {
                setActionError(null);
                setOpenMenu((prev) => (prev === "worktree" ? null : "worktree"));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
                <path d="M6.5 10v4a3 3 0 0 0 3 3H14" />
              </svg>
              <span className="composer-context-mono">
                {currentWorktree
                  ? (currentWorktree.isMain ? t("workspaceHud.mainRepo") : worktreeLabel(currentWorktree))
                  : (isLinkedWorktree ? folderName : t("workspaceHud.mainRepo"))}
              </span>
              <span className="composer-context-caret" aria-hidden="true">▾</span>
            </button>

            {openMenu === "worktree" && (
              <div className="composer-context-popover" role="menu">
                <div className="composer-context-pop-header">
                  {isNewSession
                    ? t("workspaceHud.worktreeNewSessionHint")
                    : t("workspaceHud.worktreeExistingSessionHint")}
                </div>
                {actionError && <div className="composer-context-pop-error">{actionError}</div>}

                {onCreateWorktree && (
                  <>
                    <button
                      type="button"
                      className="composer-context-pop-toggle"
                      onClick={() => setCreateToggle((prev) => !prev)}
                    >
                      <span>{t("workspaceHud.createWorktreeToggle")}</span>
                      <span className={`composer-context-switch${createToggle ? " is-on" : ""}`} aria-hidden="true" />
                    </button>
                    {createToggle && (
                      <div className="composer-context-create-box">
                        <input
                          type="text"
                          className="composer-context-create-input"
                          value={newBranchName}
                          onChange={(event) => setNewBranchName(event.target.value)}
                          placeholder={t("workspaceHud.newWorktreePlaceholder")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void handleCreateWorktree();
                            }
                          }}
                        />
                        <button
                          type="button"
                          disabled={mutating || !newBranchName.trim()}
                          className="composer-context-create-btn"
                          onClick={() => void handleCreateWorktree()}
                        >
                          {mutating ? t("workspaceHud.creating") : t("workspaceHud.createNow")}
                        </button>
                      </div>
                    )}
                    {worktrees.length > 0 && <div className="composer-context-pop-sep" />}
                  </>
                )}

                {worktrees.length > 0 && (
                  <div className="composer-context-pop-list">
                    {worktrees.map((wt) => {
                      const isCurrent = wt.path === cwd;
                      const branchDisplay = worktreeBranchDisplay(wt);
                      return (
                        <button
                          key={wt.path}
                          type="button"
                          disabled={mutating}
                          className={`composer-context-pop-row${isCurrent ? " is-current" : ""}`}
                          onClick={() => {
                            setOpenMenu(null);
                            if (!isCurrent) onSelectWorktree?.(wt);
                          }}
                        >
                          <span className="composer-context-pop-row-main">
                            <span aria-hidden="true">{isCurrent ? "●" : "○"}</span>
                            <span className="composer-context-pop-name">
                              {wt.isMain ? `${worktreeLabel(wt)} (${t("workspaceHud.mainRepo")})` : worktreeLabel(wt)}
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
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});
