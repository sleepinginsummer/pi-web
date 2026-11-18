"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { isObserverStaged, setObserverStaged, subscribeToStagedObserver } from "@/lib/new-session-materialization-client";
import { SessionSwitchTrack } from "./SessionSwitchTrack";

export function ObserverSessionToggle({ sessionId, compact, showLabel = false }: { sessionId: string; compact: boolean; showLabel?: boolean }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void sendAgentCommand<{ enabled: boolean }>(sessionId, { type: "get_session_observer", enabledOnly: true }).then(
      (state) => { if (active) setEnabled(state.enabled); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [sessionId]);

  async function toggle() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const command = enabled === null
        ? { type: "get_session_observer", enabledOnly: true }
        : { type: "set_session_observer_enabled", enabled: !enabled };
      const state = await sendAgentCommand<{ enabled: boolean }>(sessionId, command);
      setEnabled(state.enabled);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const disabled = pending || (enabled === null && !failed);
  const label = t("observer.enable");
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={enabled === true}
      aria-busy={pending || undefined}
      title={failed ? t("observer.error") : label}
      disabled={disabled}
      onClick={() => void toggle()}
      className="flex h-full shrink-0 items-center gap-1.5 hover:bg-[var(--bg-selected)] disabled:cursor-not-allowed"
      style={{ paddingInline: compact ? 8 : 10 }}
    >
      {showLabel && <span>{t("observer.label")}</span>}
      <SessionSwitchTrack checked={enabled === true} pending={disabled} />
    </button>
  );
}

export function DraftObserverSessionToggle({ cwd, disabled, compact }: { cwd: string; disabled: boolean; compact: boolean }) {
  const { t } = useI18n();
  const enabled = useSyncExternalStore(subscribeToStagedObserver, () => isObserverStaged(cwd), () => false);
  const label = t("observer.enable");
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      title={label}
      disabled={disabled}
      onClick={() => setObserverStaged(cwd, !enabled)}
      className="flex h-full shrink-0 items-center gap-1.5 px-2 text-text-muted hover:bg-[var(--bg-selected)] disabled:cursor-not-allowed"
    >
      {!compact && <span>{t("observer.label")}</span>}
      <SessionSwitchTrack checked={enabled} pending={disabled} />
    </button>
  );
}
