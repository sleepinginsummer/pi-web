"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearDraft } from "@/lib/draft-store";
import { releaseNewSessionMaterialization } from "@/lib/new-session-materialization-client";
import { replaceSessionUrl } from "@/lib/session-navigation-url";
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
  const suppressCwdBumpRef = useRef(false);
  activeSessionIdRef.current = selectedSession?.id ?? null;

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
    invalidateNotificationNavigation();
    applySessionSelection(session, isRestore);
  }, [applySessionSelection, invalidateNotificationNavigation]);
  const newSession = useCallback((_sessionId: string, cwd: string) => {
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
  }, [invalidateNotificationNavigation, isMobile, onMobileSelect, pendingNewSessions, resetSessionViews]);

  const sessionCreated = useCallback((session: SessionInfo) => {
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
  }, [hydrateSelectedSession, invalidateNotificationNavigation, onRefresh]);

  const sessionForked = useCallback((newSessionId: string) => {
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
  }, [hydrateSelectedSession, invalidateNotificationNavigation, onRefresh, router]);

  const sessionDeleted = useCallback((sessionId: string) => {
    invalidateNotificationNavigation();
    onRefresh();
    if (selectedSession?.id !== sessionId) return;
    setSelectedSession(null);
    setNewSessionCwd(selectedSession.cwd ?? null);
    setSessionKey((key) => key + 1);
    resetSessionViews();
    router.replace("/", { scroll: false });
  }, [invalidateNotificationNavigation, onRefresh, resetSessionViews, router, selectedSession]);

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
    invalidateNotificationNavigation();
    suppressCwdBumpRef.current = true;
    setNewSessionCwd(cwd);
  }, [invalidateNotificationNavigation]);
  const consumeCwdSyncSuppression = useCallback(() => {
    if (!suppressCwdBumpRef.current) return false;
    suppressCwdBumpRef.current = false;
    return true;
  }, []);
  const leaveWorkspace = useCallback((cwd: string) => {
    invalidateNotificationNavigation();
    setSelectedSession(null);
    setNewSessionCwd((current) => current && current !== cwd ? null : current);
    setSessionKey((key) => key + 1);
    resetSessionViews();
  }, [invalidateNotificationNavigation, resetSessionViews]);
  const updateDraftCwd = useCallback((cwd: string | null) => {
    invalidateNotificationNavigation();
    setNewSessionCwd(cwd);
  }, [invalidateNotificationNavigation]);
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
    selectSession,
    selectedSession,
    sessionCreated,
    sessionDeleted,
    sessionForked,
    sessionKey,
    updateDraftCwd,
  };
}
