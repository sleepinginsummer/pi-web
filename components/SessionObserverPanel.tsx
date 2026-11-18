"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { sendAgentCommand } from "@/lib/agent-client";
import { SessionObserverSettingsDialog } from "./SessionObserverSettingsDialog";
import { SessionObserverHistory } from "./SessionObserverHistory";
import type { SessionObserverState } from "@/lib/session-observer-protocol";

const actionStyle = "rounded border border-border px-2 py-1 text-xs hover:bg-[var(--bg-selected)] disabled:opacity-50";



export function SessionObserverPanel({ sessionId, cwd, onClose }: {
  sessionId: string;
  cwd: string;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const mobile = useIsMobile();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!mobile || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); };
  }, [mobile]);
  const [state, setState] = useState<SessionObserverState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "write" | null>(null);
  const mutation = useRef({ pending: false, revision: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const { pending, revision } = mutation.current;
      try {
        if (!pending && !document.hidden) {
          const snapshot = await sendAgentCommand<SessionObserverState>(sessionId, { type: "get_session_observer" });
          if (active && revision === mutation.current.revision) {
            setState(snapshot);
            setError((previous) => previous === "read" ? null : previous);
          }
        }
      } catch {
        if (active && revision === mutation.current.revision) setError((previous) => previous ?? "read");
      } finally {
        if (active) timer = setTimeout(refresh, 3500);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId]);

  async function update(command: Record<string, unknown>, reportError = true): Promise<boolean> {
    if (mutation.current.pending) return false;
    mutation.current.pending = true;
    mutation.current.revision++;
    setBusy(true);
    setError(null);
    try {
      setState(await sendAgentCommand<SessionObserverState>(sessionId, command));
      return true;
    } catch {
      if (reportError) setError("write");
      return false;
    } finally {
      mutation.current.pending = false;
      setBusy(false);
    }
  }


  const content = (
    <aside className="observer-panel flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-[var(--bg-panel)] shadow-lg" id="session-observer-panel" aria-label={t("observer.label")}>
      <header className="flex items-center gap-2 border-b border-border p-3">
        <h2 className="mr-auto text-sm font-medium">{t("observer.label")}</h2>
        <button type="button" aria-haspopup="dialog" className={actionStyle} disabled={!state || busy} onClick={() => { setSaveFailed(false); setSettingsOpen(true); }}>
          {t("observer.settings")}
        </button>
        <button type="button" aria-label={t("observer.close")} title={t("observer.close")} className="rounded p-1.5 hover:bg-[var(--bg-selected)]" onClick={onClose}><X size={16} /></button>
      </header>
      {state && (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-text-muted">
          <div>
            <span>{t("observer.cost")}</span>{" "}
            <span className="whitespace-nowrap tabular-nums">{state.costUsd == null ? "—" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 8 }).format(state.costUsd)}</span>
          </div>
          <button type="button" aria-pressed={showHistory} className={`${actionStyle} shrink-0`} onClick={() => setShowHistory((visible) => !visible)}>
            {t(showHistory ? "observer.historyBack" : "observer.history")}
          </button>
        </div>
      )}
      <div className="scrollbar-subtle flex-1 space-y-3 overflow-y-auto p-3">
        {showHistory ? <SessionObserverHistory key={sessionId} sessionId={sessionId} /> : <>
        {error && <p role="alert" className="text-xs text-red-400">{t("observer.error")}</p>}
        {!state && !error && <p role="status" className="text-xs text-text-muted">{t("observer.loading")}</p>}
        {state?.checking && <p role="status" className="text-xs text-text-muted">{t("observer.checking")}</p>}
        {state && !state.items.length && !state.checking && <p className="text-xs text-text-muted">{t(state.enabled ? "observer.empty" : "observer.disabled")}</p>}
        {state && state.items.length > 0 && (
          <ul className="divide-y divide-border">
            {state.items.map((item) => (
              <li key={item.id} className="py-2">
                <label className="flex cursor-pointer items-start gap-2 text-sm [overflow-wrap:anywhere]">
                  <input type="checkbox" className="mt-0.5 shrink-0 accent-[var(--accent)]" checked={item.done} disabled={busy} onChange={(event) => void update({ type: "edit_session_observer_checklist", action: "update", id: item.id, done: event.target.checked })} />
                  <span className={item.done ? "text-text-muted line-through" : ""}>{item.title}</span>
                  {item.priority !== "normal" && <span className={item.priority === "urgent" ? "shrink-0 text-xs text-red-500" : "shrink-0 text-xs text-amber-600"}>{t("observer." + item.priority)}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        </>}
      </div>
      {settingsOpen && state && (
        <SessionObserverSettingsDialog
          cwd={cwd}
          initialSettings={state.preferences}
          busy={busy}
          failed={saveFailed}
          onCancel={() => setSettingsOpen(false)}
          onSave={async (settings) => {
            setSaveFailed(false);
            if (await update({ type: "save_session_observer_settings", ...settings }, false)) {
              setSettingsOpen(false);
            } else {
              setSaveFailed(true);
            }
          }}
        />
      )}
    </aside>
  );
  return mobile ? (
    <dialog
      ref={dialogRef}
      aria-label={t("observer.label")}
      className="observer-mobile-dialog"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }}
      onCancel={(event) => { event.stopPropagation(); event.preventDefault(); onClose(); }}
    >
      {content}
    </dialog>
  ) : content;
}
