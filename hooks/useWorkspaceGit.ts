"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatusResponse } from "@/lib/git-types";

export interface GitBranchesSnapshot {
  isGit: boolean;
  projectRoot: string | null;
  currentBranch: string | null;
  isWorktree: boolean;
  branches: string[];
  canSwitch?: boolean;
}

export interface WorkspaceGitState {
  branches: GitBranchesSnapshot | null;
  status: GitStatusResponse | null;
  loading: boolean;
  switchingBranch: boolean;
  error: string | null;
  refresh: () => void;
  switchBranch: (branch: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * 统一管理当前工作目录的 Git 分支列表与变更状态。
 * 供右上角工作区浮卡与输入框毛玻璃上下文胶囊共享同一份状态，避免重复请求。
 */
export function useWorkspaceGit(
  cwd: string | null | undefined,
  externalRefreshKey = 0,
): WorkspaceGitState {
  const [branches, setBranches] = useState<GitBranchesSnapshot | null>(null);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualTick, setManualTick] = useState(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const refresh = useCallback(() => {
    setManualTick((n) => n + 1);
  }, []);

  // 窗口重新可见/获得焦点时轻量防抖刷新（避免大仓库高频轮询）
  useEffect(() => {
    if (!cwd) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (document.visibilityState === "hidden") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setManualTick((n) => n + 1);
      }, 250);
    };
    window.addEventListener("focus", scheduleRefresh);
    document.addEventListener("visibilitychange", scheduleRefresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", scheduleRefresh);
      document.removeEventListener("visibilitychange", scheduleRefresh);
    };
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      setBranches(null);
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const encoded = encodeURIComponent(cwd);
    Promise.all([
      fetch(`/api/git/branches?cwd=${encoded}`, { signal: controller.signal, cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) {
            const payload = await res.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? `HTTP ${res.status}`);
          }
          return res.json() as Promise<GitBranchesSnapshot>;
        }),
      fetch(`/api/git/status?cwd=${encoded}`, { signal: controller.signal, cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) return null;
          return res.json() as Promise<GitStatusResponse>;
        })
        .catch(() => null),
    ])
      .then(([branchData, statusData]) => {
        if (controller.signal.aborted || cwdRef.current !== cwd) return;
        setBranches(branchData);
        setStatus(statusData);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || cwdRef.current !== cwd) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted && cwdRef.current === cwd) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [cwd, externalRefreshKey, manualTick]);

  const switchBranch = useCallback(async (branch: string): Promise<{ ok: boolean; error?: string }> => {
    if (!cwd) return { ok: false, error: "No working directory" };
    setSwitchingBranch(true);
    setError(null);
    try {
      const response = await fetch("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const data = await response.json().catch(() => ({})) as Partial<GitBranchesSnapshot> & { error?: string };
      if (!response.ok || data.error) {
        const message = data.error ?? `HTTP ${response.status}`;
        if (cwdRef.current === cwd) setError(message);
        return { ok: false, error: message };
      }
      if (cwdRef.current === cwd) {
        setBranches({
          isGit: data.isGit ?? true,
          projectRoot: data.projectRoot ?? null,
          currentBranch: data.currentBranch ?? branch,
          isWorktree: data.isWorktree ?? false,
          branches: data.branches ?? [],
          canSwitch: data.canSwitch ?? true,
        });
        // 切完分支刷新一次 git status
        setManualTick((n) => n + 1);
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cwdRef.current === cwd) setError(message);
      return { ok: false, error: message };
    } finally {
      if (cwdRef.current === cwd) setSwitchingBranch(false);
    }
  }, [cwd]);

  return { branches, status, loading, switchingBranch, error, refresh, switchBranch };
}
