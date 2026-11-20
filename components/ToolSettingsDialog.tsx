"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelsData } from "@/lib/model-types";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "@/lib/thinking-levels";
import type { ReviewToolSettings, ToolModelSelection } from "@/lib/tool-settings";

const selectStyle = "w-full min-w-0 rounded border border-border bg-[var(--bg-panel)] px-3 py-2 text-sm disabled:opacity-60";
const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow", medium: "chat.thinkingMedium",
  high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};
const modelKey = (model: ToolModelSelection) => JSON.stringify([model.provider, model.modelId]);

interface Draft {
  model: ToolModelSelection | null;
  thinkingLevel: ThinkingLevel;
}

/**
 * 扩展工具的设置，目前只有 `/review`：模型（可跟随当前会话）+ 思考强度。保存写的是扩展自己的
 * `config.json`，`system_prompt` 等其余字段原样保留，下一次 `/review` 生效。
 */
export function ToolSettingsDialog({ cwd, onClose }: { cwd?: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [settings, setSettings] = useState<ReviewToolSettings | null>(null);
  const [draft, setDraft] = useState<Draft>({ model: null, thinkingLevel: "medium" });
  const [catalog, setCatalog] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/tool-settings", { signal: controller.signal, cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { review?: ReviewToolSettings; error?: string };
        if (!response.ok || !body.review) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setSettings(body.review);
        setDraft({ model: body.review.model, thinkingLevel: body.review.thinkingLevel });
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
    void (async () => {
      try {
        const response = await fetch(`/api/models?scope=all${query}`, { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as ModelsData;
        if (!controller.signal.aborted) setCatalog(data);
      } catch {
        // 模型目录读不到时仍可保存上次的选择：下面的选项会退化为「跟随当前会话模型」。
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const selectedKey = draft.model ? modelKey(draft.model) : "";
  const availableModels = (catalog?.modelList ?? []).map((entry) => {
    const model = { provider: entry.provider, modelId: entry.id };
    return { model, key: modelKey(model), label: `${entry.name} · ${entry.providerName ?? entry.provider}` };
  });
  const selectedAvailable = availableModels.some(({ key }) => key === selectedKey);
  // 目录里查不到所选模型（模型列表失败、模型已删除、扩展在运行时注册）时无法得知它支持哪些等级：
  // 按全部等级显示，否则强度下拉框没有任何选项，用户连当前值都改不了。具体模型不支持时由扩展报出来。
  const knownLevels = draft.model
    ? catalog?.thinkingLevels[`${draft.model.provider}:${draft.model.modelId}`] ?? []
    : THINKING_LEVELS;
  const levels: readonly ThinkingLevel[] = knownLevels.length > 0 ? knownLevels : THINKING_LEVELS;
  const levelsUnknown = Boolean(draft.model) && knownLevels.length === 0;
  const levelKey = levels.join(",");
  useEffect(() => {
    // 换模型后把不支持的强度拉回一个可用值，避免保存一份扩展会拒绝的配置。
    const available = levelKey.split(",").filter(isThinkingLevel);
    setDraft((current) => (
      available.length === 0 || available.includes(current.thinkingLevel)
        ? current
        : { ...current, thinkingLevel: available[0] }
    ));
  }, [levelKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !settings || cannotSave) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tool-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "review", model: draft.model, thinkingLevel: draft.thinkingLevel }),
      });
      const body = await response.json().catch(() => ({})) as { review?: ReviewToolSettings; error?: string };
      if (!response.ok || !body.review) throw new Error(body.error ?? `HTTP ${response.status}`);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  const blocked = loading || saving;
  // 扩展与用户配置都不存在时没有底稿可写：字段与保存按钮一起禁用，不能让保存只会报错。
  const cannotSave = Boolean(settings && !settings.installed && !settings.configured);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="fixed inset-0 m-auto max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] overflow-auto rounded-lg border border-border bg-[var(--bg-panel)] text-[var(--text)] shadow-xl backdrop:bg-black/40"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        if (!saving) onClose();
      }}
      onCancel={(event) => { event.stopPropagation(); event.preventDefault(); if (!saving) onClose(); }}
    >
      <form onSubmit={submit} className="space-y-4 p-4">
        <h2 id={titleId} className="font-medium">{t("tools.settingsTitle")}</h2>

        <fieldset className="space-y-3" disabled={blocked || cannotSave}>
          <legend className="mb-1 text-xs font-medium tracking-wide text-text-dim">{t("tools.reviewTitle")}</legend>
          <label className="grid gap-1 text-sm">
            {t("tools.reviewModel")}
            <select
              className={selectStyle}
              value={selectedKey}
              onChange={(event) => {
                const model = availableModels.find((entry) => entry.key === event.target.value)?.model ?? null;
                setDraft((current) => ({ ...current, model }));
              }}
            >
              <option value="">{t("tools.followSession")}</option>
              {draft.model && !selectedAvailable && (
                <option value={selectedKey}>{draft.model.provider}/{draft.model.modelId}</option>
              )}
              {availableModels.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("tools.reviewThinking")}
            <select
              className={selectStyle}
              value={draft.thinkingLevel}
              onChange={(event) => {
                const value = event.target.value;
                if (isThinkingLevel(value)) setDraft((current) => ({ ...current, thinkingLevel: value }));
              }}
            >
              {levels.map((option) => <option key={option} value={option}>{t(thinkingLabels[option])}</option>)}
            </select>
            {levelsUnknown && (
              <span className="text-[11px] leading-relaxed text-text-dim">{t("tools.reviewLevelsUnknown")}</span>
            )}
          </label>
          {settings && (
            <p className="break-all font-mono text-[11px] leading-relaxed text-text-dim">
              {settings.configured
                ? settings.configPath
                : `${t("tools.reviewNotConfigured")} ${settings.configPath}`}
              {!settings.configured && settings.effectiveConfigPath && (
                <>
                  <br />
                  {`${t("tools.reviewEffectiveConfig")} ${settings.effectiveConfigPath}`}
                </>
              )}
            </p>
          )}
          {settings && !settings.installed && (
            <p className="text-[12px] text-[#d97706]">{t("tools.reviewNotInstalled")}</p>
          )}
        </fieldset>

        {error && <p role="alert" className="text-[12px] text-[#dc2626]">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-60">
            {t("i18n.cancel")}
          </button>
          <button type="submit" disabled={blocked || !settings || cannotSave} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-60">
            {t("i18n.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
