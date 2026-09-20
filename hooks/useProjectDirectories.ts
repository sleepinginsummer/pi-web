"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LEGACY_STORAGE_KEY = "pi-web:project-directories";

type ProjectDirectoriesResponse = { projects?: string[]; cwd?: string; error?: string };

function readLegacyProjects(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function parseResponse(response: Response): Promise<ProjectDirectoriesResponse> {
  const data = await response.json().catch(() => ({})) as ProjectDirectoriesResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

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
    const data = await parseResponse(await fetch("/api/project-directories", { cache: "no-store" }));
    let next = data.projects ?? [];
    if (migrateLegacy) {
      for (const cwd of readLegacyProjects()) {
        const migration = await fetch("/api/project-directories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        if (!migration.ok) continue;
        const migrated = await migration.json() as ProjectDirectoriesResponse;
        next = migrated.projects ?? next;
      }
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    commitProjects(next);
    return next;
  }, [commitProjects]);

  const refreshProjects = useCallback(() => enqueue(() => load(false)), [enqueue, load]);

  const addProject = useCallback((cwd: string) => enqueue(async () => {
    const data = await parseResponse(await fetch("/api/project-directories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    }));
    const next = data.projects ?? [];
    commitProjects(next);
    return { projects: next, cwd: data.cwd ?? cwd };
  }), [commitProjects, enqueue]);

  const removeProject = useCallback((cwd: string) => enqueue(async () => {
    const data = await parseResponse(await fetch("/api/project-directories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    }));
    const next = data.projects ?? [];
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
