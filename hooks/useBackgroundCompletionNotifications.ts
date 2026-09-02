"use client";

import { useEffect, useRef } from "react";
import type { RunningSessionTransitionEvent } from "@/hooks/useRunningSessionTransitions";
import type { SessionNotificationOptions } from "@/lib/session-notifications";

type NotifySession = (
  title: string,
  body: string,
  sessionId?: string | null,
  options?: SessionNotificationOptions,
) => Promise<void>;

/** 消费一次性后台完成 transition，避免重渲染或语言切换重复通知。 */
export function useBackgroundCompletionNotifications(
  transition: RunningSessionTransitionEvent,
  notifySession: NotifySession,
  title: string,
  body: string,
  getFolderName: (sessionId: string) => string | undefined,
): void {
  const consumedRevisionRef = useRef(0);

  useEffect(() => {
    if (transition.revision <= consumedRevisionRef.current) return;
    consumedRevisionRef.current = transition.revision;
    for (const sessionId of transition.completedInBackground) {
      void notifySession(title, body, sessionId, { folderName: getFolderName(sessionId) });
    }
  }, [body, getFolderName, notifySession, title, transition]);
}
