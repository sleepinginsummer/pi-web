"use client";

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelSelectionViewState } from "@/lib/model-selection-types";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

const MODEL_FILTER_THRESHOLD = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => (
    `${option.name} ${option.modelId}`.toLocaleLowerCase().includes(normalizedQuery)
  ));
}

interface ModelPickerProps {
  isMobile: boolean;
  isStreaming: boolean;
  modelState: ModelSelectionViewState;
  onModelChange?: (provider: string, modelId: string) => void;
}

/** 模型选择器自行管理菜单状态，避免输入文字变化时重复构建完整模型菜单。 */
export const ModelPicker = memo(function ModelPicker({
  isMobile,
  isStreaming,
  modelState,
  onModelChange,
}: ModelPickerProps) {
  const { t } = useI18n();
  const { model, isAutoModelSelection, names: modelNames, list: modelList, error: modelError } = modelState;
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((item) => ({ provider: item.provider, modelId: item.id, name: item.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  }, [model?.provider, modelList, modelNames]);
  const filteredOptions = useMemo(() => filterModelOptions(modelOptions, filter), [filter, modelOptions]);
  const groups = useMemo(() => {
    const optionsByProvider = new Map<string, ModelOption[]>();
    for (const option of filteredOptions) {
      const options = optionsByProvider.get(option.provider);
      if (options) options.push(option);
      else optionsByProvider.set(option.provider, [option]);
    }
    return Array.from(optionsByProvider, ([provider, options]) => ({ provider, options }));
  }, [filteredOptions]);
  const currentName = useMemo(() => (
    model
      ? (modelOptions.find((option) => option.modelId === model.modelId && option.provider === model.provider)?.name ?? model.modelId)
      : null
  ), [model, modelOptions]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  if ((!modelOptions.length && !currentName && !modelError) || !onModelChange) return null;

  return (
    <div ref={triggerRef} style={{ position: "relative", flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}>
      <button
        onClick={(event) => {
          const nextRect = event.currentTarget.getBoundingClientRect();
          setRect({ top: nextRect.top, left: nextRect.left, width: nextRect.width });
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
        disabled={isStreaming}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          justifyContent: isMobile ? "flex-start" : undefined,
          padding: isMobile ? "8px 10px" : "8px 12px", height: 32,
          width: isMobile ? "100%" : undefined, maxWidth: isMobile ? "100%" : 220,
          overflow: "hidden", background: open ? "var(--bg-hover)" : "none",
          border: "none", borderRadius: 9, color: "var(--text-muted)",
          cursor: isStreaming ? "not-allowed" : "pointer", fontSize: 12,
          opacity: isStreaming ? 0.5 : 1, transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          if (isStreaming) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = "var(--text-muted)";
        }}
        title={modelOptions.length > 0 ? "Change model" : "No available models"}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {currentName ?? (modelOptions.length > 0 ? "Select model" : "No models")}
        </span>
      </button>
      {open && rect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const panelPosition: React.CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
          : { left: rect.left, width: "max-content", minWidth: rect.width };
        return (
          <div ref={panelRef} style={{
            position: "fixed", bottom: viewportHeight - rect.top + 6, ...panelPosition,
            zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)", overflow: "hidden",
            maxHeight: Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6)), display: "flex", flexDirection: "column",
          }}>
            {modelOptions.length > MODEL_FILTER_THRESHOLD && (
              <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <input value={filter} onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") { setFilter(""); setOpen(false); } }}
                  placeholder={t("chat.filterModels")} aria-label={t("chat.filterModels")} autoFocus autoComplete="off" spellCheck={false}
                  style={{ width: "100%", minWidth: isMobile ? 0 : 220, fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }} />
              </div>
            )}
            <div style={{ minHeight: 0, overflowY: "auto" }}>
              {groups.length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {filter.trim() ? t("chat.noMatchingModels") : "No available models"}
                </div>
              ) : groups.map((group, groupIndex) => (
                <div key={group.provider}>
                  {groups.length > 1 && <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", borderTop: groupIndex > 0 ? "1px solid var(--border)" : "none" }}>{group.provider}</div>}
                  {group.options.map((option) => {
                    const active = option.modelId === model?.modelId && option.provider === model?.provider;
                    return <button key={`${option.provider}:${option.modelId}`}
                      onClick={() => { setOpen(false); setFilter(""); if (!active || isAutoModelSelection) onModelChange(option.provider, option.modelId); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", background: active ? "var(--bg-selected)" : "none", border: "none", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left", fontWeight: active ? 600 : 400, whiteSpace: "nowrap" }}
                      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = "none"; }}>
                      {active ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg> : <span style={{ width: 10, flexShrink: 0 }} />}
                      {option.name}
                    </button>;
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
});

