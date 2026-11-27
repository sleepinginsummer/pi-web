"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearTabOpenSession, setTabOpenNewSession, setTabOpenSession } from "@/lib/tab-session";
import { clearDraft } from "@/lib/draft-store";
import { releaseNewSessionMaterialization } from "@/lib/new-session-materialization-client";
import { replaceSessionUrl } from "@/lib/session-navigation-url";
import { clearLastOpen, getLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { clearPendingNewSessionControl, latestPendingNewSessionControl, mirrorPendingNewSessionControl } from "@/lib/pending-new-session-mirror";
import { useNotificationSessionNavigation } from "@/hooks/useNotificationSessionNavigation";
import {
  DEFAULT_PENDING_NEW_SESSION_CONTROL,
  reducePendingNewSession,
  type PendingNewSessionControl,
  type PendingNewSessionEvent,
} from "@/lib/pending-new-session";
import type { SessionInfo } from "@/lib/types";
import { portablePathIdentity } from "@/lib/path-equality";

interface UseSessionNavigationOptions {
  initialSessionId: string | null;
  isMobile: boolean;
  onMobileSelect: () => void;
  onRefresh: () => void;
  resetSessionViews: () => void;
  onAutoTopPinSession?: (sessionId: string) => void;
}

export function useSessionNavigation({ initialSessionId, isMobile, onMobileSelect, onRefresh, resetSessionViews, onAutoTopPinSession }: UseSessionNavigationOptions) {
  const router = useRouter();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // DELETE 可能在用户切走后才完成；回调需读取最新选择，而非点击删除时捕获的旧值。
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const newSessionCwdRef = useRef(newSessionCwd);
  newSessionCwdRef.current = newSessionCwd;
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
  // 草稿级、已启动在途、已绑定 sessionId 三段隔离，防止并发普通新建清除正在创建的置顶意图。
  const draftAutoTopPinCwdsRef = useRef<Set<string>>(new Set());
  const inFlightAutoTopPinCwdsRef = useRef<Map<string, { restoreDraftOnFail: boolean }>>(new Map());
  const autoTopPinSessionIdsRef = useRef<Set<string>>(new Set());

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
    setTabOpenSession(selectedSession.id);
  }, [selectedSession]);

  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((response) => response.ok ? response.json() as Promise<{ sessions: SessionInfo[] }> : null)
      .then((data) => {
        const full = data?.sessions.find((session) => session.id === sessionId);
        // 首条消息还在等初始化时文件里没有消息，保留已知的正文，通知和标题不会变成 "(no messages)"。
        if (full) setSelectedSession((current) => current?.id === sessionId && !current.projectRoot
          ? (full.messageCount === 0 ? { ...full, firstMessage: current.firstMessage } : full)
          : current);
      })
      .catch(() => {});
  }, []);

  const requestSidebarLocate = useCallback((sessionId: string) => {
    const revision = notificationLocateRevisionRef.current + 1;
    notificationLocateRevisionRef.current = revision;
    setNotificationSessionLocateRequest({ sessionId, revision });
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
    requestSidebarLocate(session.id);
    bumpSessionKey();
    resetSessionViews();
    setInitialSessionRestored(true);
    if (isMobile && !isRestore) onMobileSelect();
    if (isRestore) suppressCwdBumpRef.current = true;
    if (!isRestore || new URLSearchParams(window.location.search).get("session") !== session.id) {
      replaceSessionUrl(session.id);
    }
  }, [bumpSessionKey, isMobile, onMobileSelect, requestSidebarLocate, resetSessionViews]);

  const isActiveSession = useCallback((sessionId: string) => activeSessionIdRef.current === sessionId, []);
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
  const newSession = useCallback((_sessionId: string, cwd: string, options?: { topPinOnCreate?: boolean }) => {
    const pathKey = portablePathIdentity(cwd);
    if (options?.topPinOnCreate) {
      draftAutoTopPinCwdsRef.current.add(pathKey);
    } else {
      draftAutoTopPinCwdsRef.current.delete(pathKey);
      const inFlight = inFlightAutoTopPinCwdsRef.current.get(pathKey);
      if (inFlight) inFlight.restoreDraftOnFail = false;
    }
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    activeSessionIdRef.current = null;
    setSelectedSession(null);
    if (!pendingNewSessions.has(cwd)) {
      setPendingNewSessions((current) => new Map(current).set(cwd, DEFAULT_PENDING_NEW_SESSION_CONTROL));
      mirrorPendingNewSessionControl(cwd, DEFAULT_PENDING_NEW_SESSION_CONTROL);
    }
    setNewSessionCwd(cwd);
    setTabOpenNewSession(cwd);
    bumpSessionKey();
    resetSessionViews();
    if (isMobile) onMobileSelect();
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    url.searchParams.set("cwd", cwd);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore, isMobile, onMobileSelect, pendingNewSessions, resetSessionViews]);

  const consumeAutoTopPin = useCallback((session: SessionInfo) => {
    const pathKey = portablePathIdentity(session.cwd);
    const shouldPin = autoTopPinSessionIdsRef.current.delete(session.id)
      || inFlightAutoTopPinCwdsRef.current.delete(pathKey)
      || draftAutoTopPinCwdsRef.current.delete(pathKey);
    if (!shouldPin) return;
    onAutoTopPinSession?.(session.id);
  }, [onAutoTopPinSession]);
  const sessionCreated = useCallback((session: SessionInfo, options?: { preserveDraft?: boolean }) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    activeSessionIdRef.current = session.id;
    // 暂存库首发由捕获的迁移记录决定源清理，不能删除等待期间的新输入。
    if (!options?.preserveDraft) clearDraft(`new:${session.cwd}`);
    releaseNewSessionMaterialization(session.cwd);
    setNewSessionCwd(null);
    setPendingNewSessions((current) => {
      if (!current.has(session.cwd)) return current;
      const next = new Map(current);
      next.delete(session.cwd);
      return next;
    });
    clearPendingNewSessionControl(session.cwd);
    consumeAutoTopPin(session);
    setSelectedSession(session);
    requestSidebarLocate(session.id);
    setTabOpenSession(session.id);
    onRefresh();
    hydrateSelectedSession(session.id);
    replaceSessionUrl(session.id);
  }, [consumeAutoTopPin, hydrateSelectedSession, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, requestSidebarLocate]);

  /** 发送途中用户已切走：只收尾和刷新侧栏；如果又回到了这个目录的新会话页，才进入该会话。 */
  const sessionCreatedInBackground = useCallback((session: SessionInfo) => {
    releaseNewSessionMaterialization(session.cwd);
    setPendingNewSessions((current) => {
      if (!current.has(session.cwd)) return current;
      const next = new Map(current);
      next.delete(session.cwd);
      return next;
    });
    clearPendingNewSessionControl(session.cwd);
    consumeAutoTopPin(session);
    onRefresh();
    if (newSessionCwdRef.current !== session.cwd || activeSessionIdRef.current !== null) return;
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    applySessionSelection(session);
    hydrateSelectedSession(session.id);
  }, [applySessionSelection, consumeAutoTopPin, hydrateSelectedSession, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh]);

  const sessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    activeSessionIdRef.current = newSessionId;
    setTabOpenSession(newSessionId);
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
    clearTabOpenSession(sessionId);
    const active = selectedSessionRef.current;
    if (active?.id !== sessionId) return;
    activeSessionIdRef.current = null;
    setSelectedSession(null);
    setNewSessionCwd(active.cwd ?? null);
    if (active.cwd) setTabOpenNewSession(active.cwd);
    bumpSessionKey();
    resetSessionViews();
    router.replace("/", { scroll: false });
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore, onRefresh, resetSessionViews, router]);

  const dispatchPending = useCallback((cwd: string, event: PendingNewSessionEvent) => {
    // 归约的输入取渲染无关的镜像，而不是 React state：创建入口可能在另一个已经卸载的实例里
    // 等着，它读不到 state；而 state 的提交时机不确定，切模任务结算与它同在一个微任务链里，
    // 按 state 归约可能接在还没提交的上一份后面。镜像同步推进，两边读到的是同一份。
    const previous = latestPendingNewSessionControl(cwd) ?? DEFAULT_PENDING_NEW_SESSION_CONTROL;
    const pathKey = portablePathIdentity(cwd);
    if (event.type === "START") {
      if (draftAutoTopPinCwdsRef.current.delete(pathKey)) {
        inFlightAutoTopPinCwdsRef.current.set(pathKey, { restoreDraftOnFail: true });
      }
    } else if (event.type === "RUNTIME_CREATED") {
      if (inFlightAutoTopPinCwdsRef.current.delete(pathKey) || draftAutoTopPinCwdsRef.current.delete(pathKey)) {
        autoTopPinSessionIdsRef.current.add(event.sessionId);
      }
    } else if (event.type === "REQUEST_FAIL") {
      const inFlight = inFlightAutoTopPinCwdsRef.current.get(pathKey);
      if (inFlight) {
        inFlightAutoTopPinCwdsRef.current.delete(pathKey);
        if (inFlight.restoreDraftOnFail) draftAutoTopPinCwdsRef.current.add(pathKey);
      }
    } else if (event.type === "DISCARD") {
      inFlightAutoTopPinCwdsRef.current.delete(pathKey);
      if ("sessionId" in previous) autoTopPinSessionIdsRef.current.delete(previous.sessionId);
    }
    const control = reducePendingNewSession(previous, event);
    mirrorPendingNewSessionControl(cwd, control);
    if (control === previous) return;
    setPendingNewSessions((current) => new Map(current).set(cwd, control));
  }, []);

  const beginInitialCwd = useCallback((cwd: string) => {
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    suppressCwdBumpRef.current = true;
    setNewSessionCwd(cwd);
    setTabOpenNewSession(cwd);
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
    if (newSessionCwdRef.current === cwd) return;
    invalidateWorkspaceRestore();
    invalidateNotificationNavigation();
    // worktree 是另一份草稿：推进导航代次并重建 ChatWindow，让运行时 ID、切模引用与
    // 所有异步回调仍留在原 cwd。正文和附件沿用按 cwd 的 draft-store 恢复路径。
    bumpSessionKey();
    newSessionCwdRef.current = cwd;
    setNewSessionCwd(cwd);
    if (cwd) setTabOpenNewSession(cwd);
  }, [bumpSessionKey, invalidateNotificationNavigation, invalidateWorkspaceRestore]);

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
  const markInitialRestorePending = useCallback(() => setInitialSessionRestored(false), []);
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
    markInitialRestorePending,
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
    sessionCreatedInBackground,
    sessionDeleted,
    sessionForked,
    sessionKey,
    syncWorkspaceKey,
    updateDraftCwd,
  };
}
