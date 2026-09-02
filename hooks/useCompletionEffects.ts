"use client";

import { useEffect, useRef } from "react";
import type { RunCompletion } from "@/hooks/useRunCompletion";
import type { SessionNotificationOptions } from "@/lib/session-notifications";

interface CompletionEffectsOptions {
  completion: RunCompletion | null;
  soundEnabled: boolean;
  playDoneSound: () => void;
  notifySession: (title: string, body: string, sessionId?: string | null, options?: SessionNotificationOptions) => Promise<void>;
  title: string;
  body: string;
  folderName?: string;
  onComplete?: () => void;
}

/** 统一消费主运行完成事件，保证声音、系统通知和上层回调属于同一个完成边界。 */
export function useCompletionEffects({
  completion,
  soundEnabled,
  playDoneSound,
  notifySession,
  title,
  body,
  folderName,
  onComplete,
}: CompletionEffectsOptions) {
  const handledRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!completion || handledRunIdRef.current === completion.runId) return;
    handledRunIdRef.current = completion.runId;

    if (soundEnabled) playDoneSound();
    void notifySession(title, body, completion.sessionId, { folderName, showWhenActive: true });
    onComplete?.();
  }, [body, completion, folderName, notifySession, onComplete, playDoneSound, soundEnabled, title]);
}
