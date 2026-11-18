"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelsData, SelectedModel } from "@/lib/model-types";
import { DEFAULT_OBSERVER_INTERVAL, isObserverInterval, type ObserverModelPreferences } from "@/lib/session-observer-protocol";
import { isThinkingLevel, type ThinkingLevel } from "@/lib/thinking-levels";

const selectStyle = "w-full min-w-0 rounded border border-border bg-[var(--bg-panel)] px-3 py-2 text-sm disabled:opacity-60";
const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow", medium: "chat.thinkingMedium",
  high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};
const modelKey = (model: SelectedModel) => JSON.stringify([model.provider, model.modelId]);

export function SessionObserverSettingsDialog({ cwd, initialSettings, busy, failed, onCancel, onSave }: {
  cwd: string;
  initialSettings: ObserverModelPreferences;
  busy: boolean;
  failed: boolean;
  onCancel: () => void;
  onSave: (settings: ObserverModelPreferences) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState(initialSettings);
  const [interval, setIntervalDraft] = useState(String(initialSettings.interval ?? DEFAULT_OBSERVER_INTERVAL));
  const [catalog, setCatalog] = useState<ModelsData | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/models?scope=all&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as ModelsData;
        if (!controller.signal.aborted) {
          setCatalog(data);
          setCatalogFailed(Boolean(data.modelError));
        }
      } catch {
        if (!controller.signal.aborted) setCatalogFailed(true);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const { model: selected, thinkingLevel: level } = draft;
  const selectedKey = selected ? modelKey(selected) : "";
  const availableModels = (catalog?.modelList ?? []).map((entry) => {
    const model = { provider: entry.provider, modelId: entry.id };
    return { model, key: modelKey(model), label: `${entry.name} · ${entry.providerName ?? entry.provider}` };
  });
  const selectedAvailable = availableModels.some(({ key }) => key === selectedKey);
  const levelsFor = (model: SelectedModel) => catalog?.thinkingLevels[`${model.provider}:${model.modelId}`] ?? [];
  const levels = selected ? levelsFor(selected) : [];

  function changeModel(key: string) {
    const model = availableModels.find((entry) => entry.key === key)?.model ?? null;
    setDraft({ ...draft, model, thinkingLevel: model && level && levelsFor(model).includes(level) ? level : null });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && isObserverInterval(Number(interval))) onSave({ ...draft, interval: Number(interval) });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="observer-settings-dialog fixed inset-0 m-auto max-h-[calc(100%-2rem)] w-[min(26rem,calc(100%-2rem))] overflow-auto rounded-lg border border-border bg-[var(--bg-panel)] text-[var(--text)] shadow-xl backdrop:bg-black/40"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onCancel={(event) => { event.stopPropagation(); event.preventDefault(); if (!busy) onCancel(); }}
    >
      <form onSubmit={submit} className="space-y-4 p-4">
        <h2 id={titleId} className="font-medium">{t("observer.settings")}</h2>
        <label className="grid gap-1 text-sm">
          {t("observer.model")}
          <select className={selectStyle} value={selectedKey} disabled={busy || (!catalog && !selected)} onChange={(event) => changeModel(event.target.value)}>
            <option value="">{t("observer.followSession")}</option>
            {selected && !selectedAvailable && <option value={selectedKey} disabled>{selected.provider}/{selected.modelId}</option>}
            {availableModels.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("observer.thinking")}
          <select className={selectStyle} value={level ?? ""} disabled={busy || !selectedAvailable || !levels.length} onChange={(event) => {
            const value = event.target.value;
            setDraft({ ...draft, thinkingLevel: isThinkingLevel(value) ? value : null });
          }}>
            <option value="">{t("observer.followSession")}</option>
            {level && !levels.includes(level) && <option value={level} disabled>{t(thinkingLabels[level])}</option>}
            {levels.map((option) => <option key={option} value={option}>{t(thinkingLabels[option])}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("observer.interval")}
          <input className={selectStyle} type="number" inputMode="numeric" min={1} step={1} required disabled={busy} value={interval} onChange={(event) => setIntervalDraft(event.target.value)} />
        </label>
        {catalogFailed && <p role="status" className="text-xs text-text-muted">{t("observer.modelsUnavailable")}</p>}
        {failed && <p role="alert" className="text-sm text-red-400">{t("observer.saveFailed")}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50" onClick={onCancel}>{t("i18n.cancel")}</button>
          <button type="submit" disabled={busy} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)] disabled:opacity-50">{t(busy ? "i18n.saving" : "i18n.save")}</button>
        </div>
      </form>
    </dialog>
  );
}
