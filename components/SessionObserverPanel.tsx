"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { SessionObserverSettingsDialog } from "./SessionObserverSettingsDialog";
import { OBSERVER_FEEDBACK_LIMIT, type ObserverCard, type ObserverFeedback, type SessionObserverState } from "@/lib/session-observer-protocol";

const actionStyle = "rounded border border-border px-2 py-1 text-xs hover:bg-[var(--bg-selected)] disabled:opacity-50";


function ObserverNoteCard({ card, busy, onFeedback, onDiscuss }: {
  card: ObserverCard;
  busy: boolean;
  onFeedback: (feedback: ObserverFeedback) => Promise<boolean>;
  onDiscuss: () => void;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (await onFeedback({ kind: "reply", text: reply.trim() })) {
      setReply("");
      setReplyOpen(false);
    }
  };

  return (
    <article className="space-y-2 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]">
      <details>
        <summary className="cursor-pointer font-medium">{card.title}</summary>
        <p className="mt-2 whitespace-pre-wrap text-text-muted">{card.detail}</p>
      </details>
      {card.feedback.length > 0 && (
        <ul className="space-y-1 border-l border-border pl-2 text-xs text-text-muted">
          {card.feedback.map((feedback, index) => (
            <li key={index} className="whitespace-pre-wrap">{feedback.text || t(feedback.kind === "known" ? "observer.known" : feedback.kind === "expired" ? "observer.expired" : "observer.dismissed")}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        {card.feedback.length === 0 && (
          <>
            <button type="button" className={actionStyle} disabled={busy} onClick={() => void onFeedback({ kind: "known" })}>{t("observer.known")}</button>
            <button type="button" className={actionStyle} disabled={busy} onClick={() => void onFeedback({ kind: "dismiss" })}>{t("observer.dismiss")}</button>
          </>
        )}
        <button type="button" className={actionStyle} aria-expanded={replyOpen} onClick={() => setReplyOpen(!replyOpen)}>{t("observer.reply")}</button>
        <button type="button" className={actionStyle} onClick={onDiscuss}>{t("observer.discuss")}</button>
      </div>
      {replyOpen && (
        <form className="flex flex-col items-end gap-1.5" onSubmit={send}>
          <textarea aria-label={t("observer.reply")} className="w-full rounded border border-border bg-transparent p-1.5 text-sm" rows={3} maxLength={OBSERVER_FEEDBACK_LIMIT} value={reply} onChange={(event) => setReply(event.target.value)} />
          <button type="submit" className={actionStyle} disabled={busy || !reply.trim()}>{t("observer.send")}</button>
        </form>
      )}
    </article>
  );
}

export function SessionObserverPanel({ sessionId, cwd, onClose, onDiscuss }: {
  sessionId: string;
  cwd: string;
  onClose: () => void;
  onDiscuss: (card: ObserverCard) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<SessionObserverState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "write" | null>(null);
  const mutation = useRef({ pending: false, revision: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
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


  return (
    <aside id="session-observer-panel" aria-label={t("observer.label")} className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-[var(--bg-panel)] shadow-lg">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <h2 className="mr-auto text-sm font-medium">{t("observer.label")}</h2>
        <button type="button" aria-haspopup="dialog" className={actionStyle} disabled={!state || busy} onClick={() => { setSaveFailed(false); setSettingsOpen(true); }}>
          {t("observer.settings")}
        </button>
        <button type="button" aria-label={t("observer.close")} title={t("observer.close")} className="rounded p-1.5 hover:bg-[var(--bg-selected)]" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="scrollbar-subtle flex-1 space-y-3 overflow-y-auto p-3">
        {error && <p role="alert" className="text-xs text-red-400">{t("observer.error")}</p>}
        {!state && !error && <p role="status" className="text-xs text-text-muted">{t("observer.loading")}</p>}
        {state?.checking && <p role="status" className="text-xs text-text-muted">{t("observer.checking")}</p>}
        {state && !state.cards.length && !state.checking && <p className="text-xs text-text-muted">{t(state.enabled ? "observer.empty" : "observer.disabled")}</p>}
        {state?.cards.slice().reverse().map((card) => (
          <ObserverNoteCard key={card.id} card={card} busy={busy} onDiscuss={() => onDiscuss(card)} onFeedback={(feedback) => update({ type: "submit_session_observer_feedback", noteId: card.id, ...feedback })} />
        ))}
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
}
