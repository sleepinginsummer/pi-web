"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ObserverHistoryPage } from "@/lib/session-observer-protocol";

const textStyle = "mt-1 whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-2 text-xs";

export function SessionObserverHistory({ sessionId }: { sessionId: string }) {
  const { locale, t } = useI18n();
  const [page, setPage] = useState<ObserverHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  async function load(before?: string) {
    setLoading(true);
    setFailed(false);
    try {
      const result = await sendAgentCommand<ObserverHistoryPage>(sessionId, { type: "get_session_observer", history: true, before });
      setPage((previous) => before && previous
        ? { interactions: [...previous.interactions, ...result.interactions], nextBefore: result.nextBefore }
        : result);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void sendAgentCommand<ObserverHistoryPage>(sessionId, { type: "get_session_observer", history: true }).then(
      (result) => { if (active) setPage(result); },
      () => { if (active) setFailed(true); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId]);

  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 8 });
  return (
    <div className="space-y-2 text-sm">
      <div className="flex justify-end">
        <button type="button" disabled={loading} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" onClick={() => void load()}>{t("observer.historyRefresh")}</button>
      </div>
      {loading && <p role="status" className="text-xs text-text-muted">{t("observer.loading")}</p>}
      {failed && <p role="alert" className="text-xs text-red-400">{t("observer.error")}</p>}
      {page?.interactions.length === 0 && <p className="text-xs text-text-muted">{t("observer.historyEmpty")}</p>}
      {page?.interactions.map((entry) => (
        <details key={entry.id} className="rounded border border-border p-2">
          <summary className="cursor-pointer">
            {t(entry.phase === "summary" ? "observer.historySummary" : "observer.historyCheck")} · {time.format(entry.startedAt)} · {entry.costUsd == null ? "—" : currency.format(entry.costUsd)}
          </summary>
          <div className="mt-2 space-y-3 [overflow-wrap:anywhere]">
            <p className="text-xs text-text-muted">{entry.model.provider}/{entry.model.modelId} · {entry.thinkingLevel} · {t("observer.historyStatus", { status: entry.status })}</p>
            {entry.failure && <p className="text-xs text-red-400">{t(`observer.failure.${entry.failure}`)}</p>}
            <section><h3 className="font-medium">{t("observer.historyPrompt")}</h3><pre className={textStyle}>{entry.prompt}</pre></section>
            <section><h3 className="font-medium">{t("observer.historyInput")}</h3><pre className={textStyle}>{entry.input}</pre></section>
            <section>
              <h3 className="font-medium">{t("observer.historyOutput")}</h3>
              {entry.output.length === 0 && <p className="text-xs text-text-muted">—</p>}
              {entry.output.map((block, index) => (
                <div key={index}>
                  {block.type !== "text" && <p className="mt-2 text-xs text-text-muted">{t(block.type === "thinking" ? "observer.thinking" : "observer.historyToolCall")}</p>}
                  <pre className={textStyle}>{block.text}</pre>
                </div>
              ))}
            </section>
          </div>
        </details>
      ))}
      {page?.nextBefore && (
        <button type="button" disabled={loading} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" onClick={() => void load(page.nextBefore ?? undefined)}>{t("observer.historyEarlier")}</button>
      )}
    </div>
  );
}
