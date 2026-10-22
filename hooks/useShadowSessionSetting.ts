"use client";

import { useCallback, useState, type RefObject } from "react";
import type { AgentRuntimeState } from "@/lib/agent-state";
import { sendAgentCommand } from "@/lib/agent-client";
import { parseShadowMindToggleCommand, readShadowMindStateEntry } from "@/lib/shadow-session-protocol";
import type { SessionEntry } from "@/lib/types";

type ShadowCommandResult =
  | { handled: false }
  | { handled: true; success: true; enabled: boolean; message: string }
  | { handled: true; success: false; error: string };

type UseShadowSessionSettingOptions = {
  sessionIdRef: RefObject<string | null>;
  addErrorNotice: (message: string) => void;
  staged: { enabled: boolean; pending: boolean; onChange: (enabled: boolean) => void } | null;
};

export function useShadowSessionSetting({
  sessionIdRef,
  addErrorNotice,
  staged,
}: UseShadowSessionSettingOptions) {
  const [runtime, setRuntime] = useState({
    sessionId: sessionIdRef.current, enabled: false, available: false, authoritative: false,
  });
  const [pending, setPending] = useState(false);
  const applyRuntimeState = useCallback((state: Pick<AgentRuntimeState,
    "sessionId" | "shadowMindEnabled" | "shadowMindAvailable" | "extensionsInitializing"> | undefined) => {
    const sessionId = sessionIdRef.current;
    if (state && state.sessionId !== sessionId) return;
    setRuntime((previous) => {
      const enabled = previous.sessionId === sessionId ? previous.enabled : false;
      // session_start 完成前的默认开启值不是恢复结果；此时保留历史值并禁用交互。
      if (!state || state.extensionsInitializing) {
        return { sessionId, enabled, available: false, authoritative: false };
      }
      return { sessionId, enabled: state.shadowMindEnabled, available: state.shadowMindAvailable, authoritative: true };
    });
  }, [sessionIdRef]);

  const restoreSnapshot = useCallback((sessionId: string, enabled: boolean | undefined) => {
    if (sessionIdRef.current !== sessionId || typeof enabled !== "boolean") return;
    setRuntime((previous) => {
      // 延迟的历史响应不能覆盖已经收到的 runtime、SSE 或用户操作结果。
      if (previous.sessionId === sessionId && previous.authoritative) return previous;
      return { sessionId, enabled, available: false, authoritative: false };
    });
  }, [sessionIdRef]);

  const consumeEntry = useCallback((entry: SessionEntry | undefined) => {
    const persisted = readShadowMindStateEntry(entry);
    if (persisted === null) return;
    const sessionId = sessionIdRef.current;
    setRuntime((previous) => ({
      sessionId, enabled: persisted,
      available: previous.sessionId === sessionId && previous.available,
      authoritative: true,
    }));
  }, [sessionIdRef]);

  const updateEnabled = useCallback(async (sessionId: string, nextEnabled: boolean): Promise<boolean> => {
    const result = await sendAgentCommand<{ enabled: boolean }>(sessionId, {
      type: "set_shadow_mind_enabled",
      enabled: nextEnabled,
    });
    const effective = result?.enabled ?? nextEnabled;
    if (sessionIdRef.current === sessionId) {
      setRuntime((previous) => ({ ...previous, sessionId, enabled: effective, authoritative: true }));
    }
    return effective;
  }, [sessionIdRef]);

  const runSlashCommand = useCallback(async (
    text: string,
    sessionId: string | null,
  ): Promise<ShadowCommandResult> => {
    const nextEnabled = parseShadowMindToggleCommand(text);
    if (nextEnabled === null) return { handled: false };
    if (!sessionId) return { handled: true, success: false, error: "No active session" };
    try {
      const effective = await updateEnabled(sessionId, nextEnabled);
      return {
        handled: true,
        success: true,
        enabled: effective,
        message: effective ? "Shadow Mind resumed" : "Shadow Mind paused",
      };
    } catch (error) {
      return { handled: true, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [updateEnabled]);

  const isCurrentSession = runtime.sessionId === sessionIdRef.current;
  const enabled = staged?.enabled ?? (isCurrentSession ? runtime.enabled : false);
  const available = staged ? true : isCurrentSession && runtime.available;
  const effectivePending = staged?.pending ?? pending;
  const stagedOnChange = staged?.onChange;

  const toggle = useCallback(async () => {
    if (effectivePending) return;
    const nextEnabled = !enabled;
    if (stagedOnChange) {
      stagedOnChange(nextEnabled);
      return;
    }
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setPending(true);
    try {
      await updateEnabled(sessionId, nextEnabled);
    } catch (error) {
      if (sessionIdRef.current === sessionId) {
        addErrorNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (sessionIdRef.current === sessionId) setPending(false);
    }
  }, [addErrorNotice, effectivePending, enabled, sessionIdRef, stagedOnChange, updateEnabled]);

  return {
    enabled,
    available,
    pending: effectivePending,
    applyRuntimeState,
    restoreSnapshot,
    consumeEntry,
    runSlashCommand,
    toggle,
  };
}
