"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  orderProjectsByPreference,
  reconcileSessionPreferenceOrder,
  reduceSidebarPreferences,
  type SidebarPreferenceAction,
  type SidebarPreferences,
} from "@/lib/sidebar-preference-state";
import {
  clearLegacySidebarPreferences,
  fetchSidebarPreferences,
  initialSidebarPreferences,
  patchSidebarPreferences,
  patchSidebarPreferencesWithRetry,
  readLegacySidebarPreferences,
} from "@/lib/sidebar-preferences-client";
import type { SessionInfo } from "@/lib/types";

/** 侧边栏排序与 Pin 的唯一 React 同步边界。 */
export function useSidebarPreferences(sessions: SessionInfo[], sessionsReady: boolean) {
  const [preferences, setPreferences] = useState<SidebarPreferences>(initialSidebarPreferences);
  const [initialized, setInitialized] = useState(false);
  const preferencesRef = useRef(preferences);
  const revisionRef = useRef(preferences.revision);
  const operationChainRef = useRef(Promise.resolve());
  const latestOperationRef = useRef(0);
  const previousSessionIdsRef = useRef<Set<string> | null>(null);

  const commitSnapshot = useCallback((snapshot: SidebarPreferences) => {
    preferencesRef.current = snapshot;
    revisionRef.current = snapshot.revision;
    setPreferences(snapshot);
  }, []);

  const refresh = useCallback(async () => {
    try {
      commitSnapshot(await fetchSidebarPreferences());
    } catch (error) {
      console.error("加载侧边栏偏好失败", error);
    }
  }, [commitSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const loadAndMigrate = async () => {
      try {
        let snapshot = await fetchSidebarPreferences();
        if (cancelled) return;
        commitSnapshot(snapshot);

        const legacy = readLegacySidebarPreferences();
        const hasLegacy = legacy.sessionOrder.length > 0 || legacy.pinnedSessionIds.length > 0;
        if (!snapshot.legacyMigrationCompleted && hasLegacy) {
          const action: SidebarPreferenceAction = { type: "merge_legacy", ...legacy };
          let result = await patchSidebarPreferences(snapshot.revision, action);
          if (result.conflict && !result.preferences.legacyMigrationCompleted) {
            result = await patchSidebarPreferences(result.preferences.revision, action);
          }
          snapshot = result.preferences;
          if (cancelled) return;
          commitSnapshot(snapshot);
        }
        if (snapshot.legacyMigrationCompleted) clearLegacySidebarPreferences();
        if (!cancelled) setInitialized(true);
      } catch (error) {
        if (!cancelled) console.error("初始化侧边栏偏好失败", error);
      }
    };
    operationChainRef.current = operationChainRef.current.then(loadAndMigrate);
    return () => { cancelled = true; };
  }, [commitSnapshot]);

  useEffect(() => {
    const refreshAfterWrites = () => {
      if (document.visibilityState !== "visible") return;
      operationChainRef.current = operationChainRef.current.then(refresh);
    };
    window.addEventListener("focus", refreshAfterWrites);
    document.addEventListener("visibilitychange", refreshAfterWrites);
    return () => {
      window.removeEventListener("focus", refreshAfterWrites);
      document.removeEventListener("visibilitychange", refreshAfterWrites);
    };
  }, [refresh]);

  const enqueue = useCallback((action: SidebarPreferenceAction) => {
    const optimistic = reduceSidebarPreferences(preferencesRef.current, action, false);
    if (optimistic === preferencesRef.current) return;
    const sequence = latestOperationRef.current + 1;
    latestOperationRef.current = sequence;
    preferencesRef.current = optimistic;
    setPreferences(optimistic);

    operationChainRef.current = operationChainRef.current.then(async () => {
      try {
        const result = await patchSidebarPreferencesWithRetry(revisionRef.current, action);
        revisionRef.current = result.preferences.revision;
        if (result.conflict || sequence === latestOperationRef.current) {
          commitSnapshot(result.preferences);
        } else {
          preferencesRef.current = { ...preferencesRef.current, revision: result.preferences.revision };
        }
      } catch (error) {
        console.error("更新侧边栏偏好失败", error);
        if (sequence === latestOperationRef.current) await refresh();
      }
    });
  }, [commitSnapshot, refresh]);

  useEffect(() => {
    if (!initialized || !sessionsReady) return;
    const current = new Set(sessions.map((session) => session.id));
    const previous = previousSessionIdsRef.current;
    previousSessionIdsRef.current = current;
    if (!previous) return;
    const removed = [...previous].filter((id) => !current.has(id));
    if (removed.length > 0) enqueue({ type: "remove_sessions", ids: removed });
  }, [enqueue, initialized, sessions, sessionsReady]);

  const sessionOrder = useMemo(
    () => reconcileSessionPreferenceOrder(sessions, preferences.sessionOrder),
    [preferences.sessionOrder, sessions],
  );
  const pinnedSessionIds = useMemo(() => {
    const existing = new Set(sessions.map((session) => session.id));
    return new Set(preferences.pinnedSessionIds.filter((id) => existing.has(id)));
  }, [preferences.pinnedSessionIds, sessions]);
  const pinnedProjectPaths = useMemo(() => new Set(preferences.pinnedProjectPaths), [preferences.pinnedProjectPaths]);

  const moveSession = useCallback((source: string, target: string) => {
    enqueue({ type: "move_session", source, target, visibleIds: sessionOrder });
  }, [enqueue, sessionOrder]);

  const toggleSessionPinned = useCallback((sessionId: string) => {
    enqueue({ type: "set_session_pinned", sessionId, pinned: !pinnedSessionIds.has(sessionId) });
  }, [enqueue, pinnedSessionIds]);

  const getProjectOrder = useCallback(
    (projects: string[]) => orderProjectsByPreference(projects, preferences.projectOrder),
    [preferences.projectOrder],
  );

  const moveProject = useCallback((source: string, target: string, visibleProjects: string[]) => {
    enqueue({
      type: "move_project",
      source,
      target,
      visibleIds: orderProjectsByPreference(visibleProjects, preferencesRef.current.projectOrder),
    });
  }, [enqueue]);

  const toggleProjectPinned = useCallback((project: string) => {
    enqueue({ type: "set_project_pinned", project, pinned: !pinnedProjectPaths.has(project) });
  }, [enqueue, pinnedProjectPaths]);

  const removeProjects = useCallback((ids: string[]) => {
    if (ids.length > 0) enqueue({ type: "remove_projects", ids });
  }, [enqueue]);

  return {
    sessionOrder,
    pinnedSessionIds,
    pinnedProjectPaths,
    getProjectOrder,
    moveSession,
    toggleSessionPinned,
    moveProject,
    toggleProjectPinned,
    removeProjects,
  };
}
