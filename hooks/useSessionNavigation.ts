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
  const [notificationSessionLocateRequest, setNotificationSessionLocateRequest] = useState<{ sessionId: string; revision: number } | null>(null);
  const notificationLocateRevisionRef = useRef(0);
  const activeSessionKeyRef = useRef(0);
  const [initialSessionRestored, setInitialSessionRestored] = useState(() => !initialSessionId);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeWorkspaceKeyRef = useRef<string | null>(null);
  const workspaceRestoreTokenRef = useRef(0);
  const suppressCwdBumpRef = useRef(false);

  // 导航事件先同步推进代次，再等待 React 提交新界面。旧 ChatWindow 即使仍处于事件队列中，
  // 也会在真正提交消息前发现自己已经失效。
  const bumpSessionKey = useCallback(() => {
    const nextKey = activeSessionKeyRef.current + 1;
    activeSessionKeyRef.current = nextKey;
    setSessionKey(nextKey);
  }, []);
  const isNavigationActive = useCallback((key: number) => activeSessionKeyRef.current === key, []);

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
    if (!isRestore) {
      performance.clearMarks(`pi-session:${session.id}:click`);
      performance.mark(`pi-session:${session.id}:click`);
    }
    activeSessionIdRef.current = session.id;
    setNewSessionCwd(null);
    setSelectedSession(session);
    bumpSessionKey();
    resetSessionViews();
    setInitialSessionRestored(true);
    if (isMobile && !isRestore) onMobileSelect();
    if (isRestore) suppressCwdBumpRef.current = true;
    else replaceSessionUrl(session.id);
  }, [bumpSessionKey, isMobile, onMobileSelect, resetSessionViews]);

  const isActiveSession = useCallback((sessionId: string) => activeSessionIdRef.current === sessionId, []);
  const requestSidebarLocate = useCallback((sessionId: string) => {
    const revision = notificationLocateRevisionRef.current + 1;
    notificationLocateRevisionRef.current = revision;
    setNotificationSessionLocateRequest({ sessionId, revision });
  }, []);
  const invalidateNotificationNavigation = useNotificationSessionNavigation({
    isActiveSession,
    selectSession: applySessionSelection,
    requestSidebarLocate,
  });
  const selectSession = useCallback((session: SessionInfo, isRestore = false) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    applySessionSelection(session, isRestore);
  }, [applySessionSelection, invalidateNotificationNavigation, invalidateWorkspaceRestore]);
  const newSession = useCallback((_sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    activeSessionIdRef.current = null;
    setSelectedSession(null);
    if (!pendingNewSessions.has(cwd)) {
      setPendingNewSessions((current) => new Map(current).set(cwd, DEFAULT_PENDING_NEW_SESSION_CONTROL));
    }
    setNewSessionCwd(cwd);
    bumpSessionKey();
    resetSessionViews();
    if (isMobile) onMobileSelect();
    replaceSessionUrl(null);
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore, isMobile, onMobileSelect, pendingNewSessions, resetSessionViews]);

  const sessionCreated = useCallback((session: SessionInfo) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    activeSessionIdRef.current = session.id;
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
    activeSessionIdRef.current = newSessionId;
    onRefresh();
    bumpSessionKey();
    setNewSessionCwd(null);
    setSelectedSession((current) => ({
      ...(current ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [bumpSessionKey, hydrateSelectedSession, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, router]);

  const sessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    onRefresh();
    if (selectedSession?.id !== sessionId) return;
    activeSessionIdRef.current = null;
    setSelectedSession(null);
    setNewSessionCwd(selectedSession.cwd ?? null);
    bumpSessionKey();
    resetSessionViews();
    router.replace("/", { scroll: false });
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, resetSessionViews, router, selectedSession]);

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
    activeSessionIdRef.current = null;
    setSelectedSession(null);
    setNewSessionCwd((current) => current && current !== cwd ? null : current);
    bumpSessionKey();
    resetSessionViews();
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore, resetSessionViews]);
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
  return {
    applyGeneratedTitle,
    beginInitialCwd,
    bumpSessionKey,
    completeInitialRestore,
    consumeCwdSyncSuppression,
    dispatchPending,
    initialSessionRestored,
    isActiveSession,
    isNavigationActive,
    leaveWorkspace,
    newSession,
    newSessionCwd,
    notificationSessionLocateRequest,
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
