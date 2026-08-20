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
  const [runtimeEnabled, setRuntimeEnabled] = useState(true);
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const applyRuntimeState = useCallback((state: Pick<AgentRuntimeState, "shadowMindEnabled" | "shadowMindAvailable"> | undefined) => {
    if (!state) return;
    setRuntimeEnabled(state.shadowMindEnabled);
    setRuntimeAvailable(state.shadowMindAvailable);
  }, []);

  const consumeEntry = useCallback((entry: SessionEntry | undefined) => {
    const persisted = readShadowMindStateEntry(entry);
    if (persisted !== null) setRuntimeEnabled(persisted);
  }, []);

  const updateEnabled = useCallback(async (sessionId: string, nextEnabled: boolean): Promise<boolean> => {
    const result = await sendAgentCommand<{ enabled: boolean }>(sessionId, {
      type: "set_shadow_mind_enabled",
      enabled: nextEnabled,
    });
    const effective = result?.enabled ?? nextEnabled;
    if (sessionIdRef.current === sessionId) setRuntimeEnabled(effective);
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

  const enabled = staged?.enabled ?? runtimeEnabled;
  const available = staged ? true : runtimeAvailable;
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
    consumeEntry,
    runSlashCommand,
    toggle,
  };
}
