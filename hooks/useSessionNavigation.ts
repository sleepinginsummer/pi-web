"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearDraft } from "@/lib/draft-store";
import { releaseNewSessionMaterialization } from "@/lib/new-session-materialization-client";
import { replaceSessionUrl } from "@/lib/session-navigation-url";
import { clearLastOpen, getLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { useNotificationSessionNavigation } from "@/hooks/useNotificationSessionNavigation";
import {
  DEFAULT_PENDING_NEW_SESSION_CONTROL,
  reducePendingNewSession,
  type PendingNewSessionControl,
  type PendingNewSessionEvent,
} from "@/lib/pending-new-session";
import type { SessionInfo } from "@/lib/types";

interface UseSessionNavigationOptions {
  initialSessionId: string | null;
  isMobile: boolean;
  onMobileSelect: () => void;
  onRefresh: () => void;
  resetSessionViews: () => void;
}

export function useSessionNavigation({ initialSessionId, isMobile, onMobileSelect, onRefresh, resetSessionViews }: UseSessionNavigationOptions) {
  const router = useRouter();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [pendingNewSessions, setPendingNewSessions] = useState<Map<string, PendingNewSessionControl>>(() => new Map());
  const [sessionKey, setSessionKey] = useState(0);
  const [initialSessionRestored, setInitialSessionRestored] = useState(() => !initialSessionId);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeWorkspaceKeyRef = useRef<string | null>(null);
  const workspaceRestoreTokenRef = useRef(0);
  const suppressCwdBumpRef = useRef(false);
  activeSessionIdRef.current = selectedSession?.id ?? null;

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  const syncWorkspaceKey = useCallback((workspaceKey: string) => {
    activeWorkspaceKeyRef.current = workspaceKey;
  }, []);

  useEffect(() => {
    if (!selectedSession) return;
    const workspaceKey = selectedSession.projectKey
      ?? activeWorkspaceKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(workspaceKey, selectedSession.id);
  }, [selectedSession]);

  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((response) => response.ok ? response.json() as Promise<{ sessions: SessionInfo[] }> : null)
      .then((data) => {
        const full = data?.sessions.find((session) => session.id === sessionId);
        if (full) setSelectedSession((current) => current?.id === sessionId && !current.projectRoot ? full : current);
      })
      .catch(() => {});
  }, []);

  const applySessionSelection = useCallback((session: SessionInfo, isRestore = false) => {
    if (!isRestore && activeSessionIdRef.current === session.id) return;
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((key) => key + 1);
    resetSessionViews();
    setInitialSessionRestored(true);
    if (isMobile && !isRestore) onMobileSelect();
    if (isRestore) suppressCwdBumpRef.current = true;
    else replaceSessionUrl(session.id);
  }, [isMobile, onMobileSelect, resetSessionViews]);

  const isActiveSession = useCallback((sessionId: string) => activeSessionIdRef.current === sessionId, []);
  const invalidateNotificationNavigation = useNotificationSessionNavigation({
    isActiveSession,
    selectSession: applySessionSelection,
  });
  const selectSession = useCallback((session: SessionInfo, isRestore = false) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    applySessionSelection(session, isRestore);
  }, [applySessionSelection, invalidateNotificationNavigation, invalidateWorkspaceRestore]);
  const newSession = useCallback((_sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    setSelectedSession(null);
    if (!pendingNewSessions.has(cwd)) {
      setPendingNewSessions((current) => new Map(current).set(cwd, DEFAULT_PENDING_NEW_SESSION_CONTROL));
    }
    setNewSessionCwd(cwd);
    setSessionKey((key) => key + 1);
    resetSessionViews();
    if (isMobile) onMobileSelect();
    replaceSessionUrl(null);
  }, [invalidateNotificationNavigation, invalidateWorkspaceRestore, isMobile, onMobileSelect, pendingNewSessions, resetSessionViews]);

  const sessionCreated = useCallback((session: SessionInfo) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    clearDraft(`new:${session.cwd}`);
    releaseNewSessionMaterialization(session.cwd);
    setNewSessionCwd(null);
    setPendingNewSessions((current) => {
      if (!current.has(session.cwd)) return current;
      const next = new Map(current);
      next.delete(session.cwd);
      return next;
    });
    setSelectedSession(session);
    onRefresh();
    hydrateSelectedSession(session.id);
    replaceSessionUrl(session.id);
  }, [hydrateSelectedSession, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh]);

  const sessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    onRefresh();
    setSessionKey((key) => key + 1);
    setNewSessionCwd(null);
    setSelectedSession((current) => ({
      ...(current ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [hydrateSelectedSession, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, router]);

  const sessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    onRefresh();
    if (selectedSession?.id !== sessionId) return;
    setSelectedSession(null);
    setNewSessionCwd(selectedSession.cwd ?? null);
    setSessionKey((key) => key + 1);
    resetSessionViews();
    router.replace("/", { scroll: false });
  }, [invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, resetSessionViews, router, selectedSession]);

  const dispatchPending = useCallback((cwd: string, event: PendingNewSessionEvent) => {
    setPendingNewSessions((current) => {
      const previous = current.get(cwd) ?? DEFAULT_PENDING_NEW_SESSION_CONTROL;
      const control = reducePendingNewSession(previous, event);
      if (control === previous) return current;
      const next = new Map(current);
      next.set(cwd, control);
      return next;
    });
  }, []);

  const beginInitialCwd = useCallback((cwd: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    suppressCwdBumpRef.current = true;
    setNewSessionCwd(cwd);
  }, [invalidateNotificationNavigation, invalidateWorkspaceRestore]);
  const consumeCwdSyncSuppression = useCallback(() => {
    if (!suppressCwdBumpRef.current) return false;
    suppressCwdBumpRef.current = false;
    return true;
  }, []);
  const leaveWorkspace = useCallback((cwd: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    setSelectedSession(null);
    setNewSessionCwd((current) => current && current !== cwd ? null : current);
    setSessionKey((key) => key + 1);
    resetSessionViews();
  }, [invalidateNotificationNavigation, invalidateWorkspaceRestore, resetSessionViews]);
  const updateDraftCwd = useCallback((cwd: string | null) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    setNewSessionCwd(cwd);
  }, [invalidateNotificationNavigation, invalidateWorkspaceRestore]);

  const restoreWorkspaceContext = useCallback((workspaceKey: string) => {
    activeWorkspaceKeyRef.current = workspaceKey;
    const token = ++workspaceRestoreTokenRef.current;
    const rememberedSessionId = getLastOpenSession(workspaceKey);
    if (!rememberedSessionId) return;

    void fetch("/api/sessions", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ sessions: SessionInfo[] }> : null)
      .then((data) => {
        if (token !== workspaceRestoreTokenRef.current) return;
        const session = data?.sessions.find((candidate) => candidate.id === rememberedSessionId);
        if (!session) {
          if (data) clearLastOpen(workspaceKey);
          return;
        }
        if (workspaceKeyOf(session) !== workspaceKey) {
          clearLastOpen(workspaceKey);
          return;
        }
        applySessionSelection(session);
      })
      .catch(() => {
        // 网络错误时保留记录，下次切换工作区后重试。
      });
  }, [applySessionSelection]);
  const completeInitialRestore = useCallback(() => setInitialSessionRestored(true), []);
  const applyGeneratedTitle = useCallback((sessionId: string, title: string) => {
    if (activeSessionIdRef.current !== sessionId) return false;
    setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
    return true;
  }, []);
  const bumpSessionKey = useCallback(() => setSessionKey((key) => key + 1), []);

  return {
    applyGeneratedTitle,
    beginInitialCwd,
    bumpSessionKey,
    completeInitialRestore,
    consumeCwdSyncSuppression,
    dispatchPending,
    initialSessionRestored,
    isActiveSession,
    leaveWorkspace,
    newSession,
    newSessionCwd,
    pendingNewSessions,
    restoreWorkspaceContext,
    selectSession,
    selectedSession,
    sessionCreated,
    sessionDeleted,
    sessionForked,
    sessionKey,
    syncWorkspaceKey,
    updateDraftCwd,
  };
}
