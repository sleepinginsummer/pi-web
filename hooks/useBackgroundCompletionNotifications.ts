"use client";

import { useEffect, useRef } from "react";
import type { RunningSessionTransitionEvent } from "@/hooks/useRunningSessionTransitions";

type NotifySession = (title: string, body: string, sessionId?: string | null) => Promise<void>;

/** 消费一次性后台完成 transition，避免重渲染或语言切换重复通知。 */
export function useBackgroundCompletionNotifications(
  transition: RunningSessionTransitionEvent,
  notifySession: NotifySession,
  title: string,
  body: string,
): void {
  const consumedRevisionRef = useRef(0);

  useEffect(() => {
    if (transition.revision <= consumedRevisionRef.current) return;
    consumedRevisionRef.current = transition.revision;
    for (const sessionId of transition.completedInBackground) {
      void notifySession(title, body, sessionId);
    }
  }, [body, notifySession, title, transition]);
}
