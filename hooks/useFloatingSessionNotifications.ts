"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionNotificationIntent } from "@/lib/session-notifications";
import {
  clearActiveFloatingSessionNotification,
  dismissFloatingSessionNotification,
  shouldQueueSessionNotification,
  upsertFloatingSessionNotification,
  type FloatingSessionNotification,
} from "@/lib/floating-session-notifications";

export function useFloatingSessionNotifications(activeSessionId: string | null) {
  const [notifications, setNotifications] = useState<FloatingSessionNotification[]>([]);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const dismissNotification = useCallback((sessionId: string) => {
    setNotifications((current) => dismissFloatingSessionNotification(current, sessionId));
  }, []);

  const enqueueNotification = useCallback((intent: SessionNotificationIntent) => {
    const { sessionId } = intent;
    if (!shouldQueueSessionNotification(activeSessionIdRef.current, sessionId, intent.showWhenActive)) return;

    setNotifications((current) => upsertFloatingSessionNotification(current, {
      sessionId,
      title: intent.title,
      body: intent.body,
      folderName: intent.folderName,
      url: intent.url,
    }));
  }, []);

  // 无论通过侧栏、URL 恢复还是通知跳转进入会话，都清除该会话的待处理通知。
  useEffect(() => {
    setNotifications((current) => clearActiveFloatingSessionNotification(current, activeSessionId));
  }, [activeSessionId]);

  return {
    dismissNotification,
    enqueueNotification,
    notifications,
  };
}
