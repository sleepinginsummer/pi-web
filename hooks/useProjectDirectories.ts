"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addProjectDirectoryClient,
  fetchProjectDirectories,
  migrateLegacyProjectDirectories,
  readLegacyProjectDirectories,
  removeProjectDirectoryClient,
  retainFailedLegacyProjectDirectories,
} from "@/lib/project-directories-client";

/** 项目目录成员集合及其增删协议的唯一客户端同步边界。 */
export function useProjectDirectories(onProjectsRemoved?: (ids: string[]) => void) {
  const [projects, setProjects] = useState<string[]>([]);
  const previousProjectsRef = useRef<Set<string> | null>(null);
  const onProjectsRemovedRef = useRef(onProjectsRemoved);
  onProjectsRemovedRef.current = onProjectsRemoved;
  const operationChainRef = useRef(Promise.resolve());

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = operationChainRef.current.then(operation, operation);
    operationChainRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const commitProjects = useCallback((next: string[]) => {
    const current = new Set(next);
    const previous = previousProjectsRef.current;
    previousProjectsRef.current = current;
    setProjects(next);
    if (!previous) return;
    const removed = [...previous].filter((project) => !current.has(project));
    if (removed.length > 0) onProjectsRemovedRef.current?.(removed);
  }, []);

  const load = useCallback(async (migrateLegacy: boolean): Promise<string[]> => {
    let next = await fetchProjectDirectories();
    if (migrateLegacy) {
      const migration = await migrateLegacyProjectDirectories(readLegacyProjectDirectories(), next);
      next = migration.projects;
      retainFailedLegacyProjectDirectories(migration.failed);
    }
    commitProjects(next);
    return next;
  }, [commitProjects]);

  const refreshProjects = useCallback(() => enqueue(() => load(false)), [enqueue, load]);

  const addProject = useCallback((cwd: string) => enqueue(async () => {
    const data = await addProjectDirectoryClient(cwd);
    commitProjects(data.projects);
    return data;
  }), [commitProjects, enqueue]);

  const removeProject = useCallback((cwd: string) => enqueue(async () => {
    const next = await removeProjectDirectoryClient(cwd);
    commitProjects(next);
    return next;
  }), [commitProjects, enqueue]);

  useEffect(() => {
    void enqueue(() => load(true)).catch((error) => console.error("加载 Pi Web 项目目录失败", error));
  }, [enqueue, load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshProjects().catch((error) => console.error("刷新 Pi Web 项目目录失败", error));
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshProjects]);

  return { projects, addProject, removeProject, refreshProjects };
}
