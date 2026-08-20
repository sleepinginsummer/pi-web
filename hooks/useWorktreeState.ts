"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorktreeInfo, WorktreeState } from "@/lib/types";
import { createWorktreeRequest, removeWorktreeRequest, WorktreeMutationError } from "../lib/worktree-client";

interface WorktreeResponse extends Partial<WorktreeState> {
  error?: string;
}
/** 校验并归一化服务端 worktree 快照，禁止把不完整响应提交到界面。 */
export function parseWorktreeState(cwd: string, data: WorktreeResponse): WorktreeState {
  if (!data.projectRoot) throw new Error(data.error ?? "worktree response is missing projectRoot");
  return {
    forCwd: cwd,
    projectRoot: data.projectRoot,
    isGit: data.isGit ?? false,
    isTopLevel: data.isTopLevel ?? false,
    worktrees: data.worktrees ?? [],
  };
}

/** 创建成功后先更新活动快照，避免切换 cwd 时短暂丢失项目归属。 */
export function appendCreatedWorktree(
  snapshot: WorktreeState | null,
  worktree: WorktreeInfo,
): WorktreeState | null {
  if (!snapshot) return null;
  if (snapshot.worktrees.some((item) => item.path === worktree.path)) return snapshot;
  return {
    ...snapshot,
    forCwd: worktree.path,
    worktrees: [...snapshot.worktrees, worktree],
  };
}

/**
 * 当前活动项目 worktree 数据的唯一客户端状态源。
 * cwd 变化或显式 refresh 时重新读取；会话列表刷新不会触发 Git 子进程。
 */
export function useWorktreeState(cwd: string | null) {
  const [snapshot, setSnapshot] = useState<WorktreeState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);


  const create = useCallback(async (branch: string): Promise<WorktreeInfo> => {
    if (!snapshot) throw new WorktreeMutationError("worktree state is unavailable");
    const created = await createWorktreeRequest(snapshot.projectRoot, branch);
    setSnapshot((previous) => appendCreatedWorktree(previous, created));
    setRefreshKey((key) => key + 1);
    return created;
  }, [snapshot]);

  const remove = useCallback(async (path: string, force: boolean): Promise<void> => {
    if (!snapshot) throw new WorktreeMutationError("worktree state is unavailable");
    await removeWorktreeRequest(snapshot.projectRoot, path, force);
    setRefreshKey((key) => key + 1);
  }, [snapshot]);

  useEffect(() => {
    if (!cwd) {
      setSnapshot(null);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as WorktreeResponse;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setSnapshot(parseWorktreeState(cwd, data));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("加载 worktree 失败", { cwd, error });
        setSnapshot(null);
      });

    return () => controller.abort();
  }, [cwd, refreshKey]);

  return { snapshot, create, remove };
}
