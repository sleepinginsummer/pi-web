"use client";

import { useCallback, useEffect, useRef } from "react";
import { NOTIFICATION_TARGET_EVENT, type NotificationTargetEventDetail } from "@/lib/notification-navigation";
import { getNotificationSessionId, replaceSessionUrl } from "@/lib/session-navigation-url";
import { NotificationNavigationGate } from "@/lib/notification-navigation-gate";
import type { SessionInfo } from "@/lib/types";

export function useNotificationSessionNavigation({
  isActiveSession,
  selectSession,
}: {
  isActiveSession: (sessionId: string) => boolean;
  selectSession: (session: SessionInfo) => void;
}) {
  const gateRef = useRef<NotificationNavigationGate | null>(null);
  if (!gateRef.current) gateRef.current = new NotificationNavigationGate();

  const invalidate = useCallback(() => {
    gateRef.current?.invalidate();
  }, []);
  useEffect(() => {
    const handleNavigation = (event: Event) => {
      const notificationEvent = event as CustomEvent<NotificationTargetEventDetail>;
      const sessionId = getNotificationSessionId(notificationEvent.detail.url, window.location.origin);
      if (!sessionId) return;
      notificationEvent.preventDefault();
      const requestGeneration = gateRef.current!.begin();
      if (isActiveSession(sessionId)) {
        replaceSessionUrl(sessionId);
        return;
      }
      void fetch("/api/sessions", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json() as { sessions?: SessionInfo[] };
          return data.sessions?.find((session) => session.id === sessionId) ?? null;
        })
        .then((session) => {
          if (!gateRef.current?.isCurrent(requestGeneration)) return;
          if (!session) throw new Error("会话信息不存在");
          selectSession(session);
        })
        .catch((error: unknown) => {
          if (gateRef.current?.isCurrent(requestGeneration)) console.error("通知目标会话切换失败", { sessionId, error });
        });
    };

    window.addEventListener(NOTIFICATION_TARGET_EVENT, handleNavigation);
    return () => window.removeEventListener(NOTIFICATION_TARGET_EVENT, handleNavigation);
  }, [isActiveSession, selectSession]);

  return invalidate;
}
