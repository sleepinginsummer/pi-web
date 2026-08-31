"use client";

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface ModelPickerOption {
  provider: string;
  modelId: string;
  name: string;
}

const MODEL_FILTER_THRESHOLD = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelPickerOption, b: ModelPickerOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const visibleLength = maxLength - 3;
  const prefixLength = Math.ceil(visibleLength / 2);
  const suffixLength = Math.floor(visibleLength / 2);
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

export function filterModelOptions(options: ModelPickerOption[], query: string): ModelPickerOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => (
    `${option.name} ${option.modelId}`.toLocaleLowerCase().includes(normalizedQuery)
  ));
}

interface ModelPickerPanelGeometry {
  triggerTop: number;
  triggerBottom?: number;
  triggerLeft: number;
  triggerWidth: number;
  viewportTop: number;
  viewportLeft: number;
  viewportWidth: number;
  viewportHeight: number;
  layoutHeight: number;
}

export function calculateModelPickerPanelLayout(
  geometry: ModelPickerPanelGeometry,
  isMobile: boolean,
  placement: "up" | "auto" = "up",
): React.CSSProperties {
  const {
    triggerTop,
    triggerBottom = triggerTop,
    triggerLeft,
    triggerWidth,
    viewportTop,
    viewportLeft,
    viewportWidth,
    viewportHeight,
    layoutHeight,
  } = geometry;

  if (!isMobile) {
    const spaceAbove = triggerTop - viewportTop - 8;
    const spaceBelow = viewportTop + viewportHeight - triggerBottom - 8;
    if (placement === "auto" && spaceBelow > spaceAbove) {
      return {
        top: triggerBottom + 6,
        left: triggerLeft,
        width: "max-content",
        minWidth: triggerWidth,
        maxHeight: Math.max(120, Math.min(spaceBelow, viewportHeight * 0.6)),
      };
    }
    return {
      bottom: layoutHeight - triggerTop + 6,
      left: triggerLeft,
      width: "max-content",
      minWidth: triggerWidth,
      maxHeight: Math.max(120, Math.min(triggerTop - 8, viewportHeight * 0.6)),
    };
  }

  // 键盘弹出后以 visual viewport 为边界，确保弹层和滚动区域均留在可见范围内。
  const margin = 8;
  const panelBottom = Math.min(triggerTop - 6, viewportTop + viewportHeight - margin);
  const availableHeight = Math.max(0, panelBottom - viewportTop - margin);

  return {
    bottom: layoutHeight - panelBottom,
    left: viewportLeft + margin,
    width: Math.max(0, viewportWidth - margin * 2),
    maxWidth: Math.max(0, viewportWidth - margin * 2),
    maxHeight: Math.min(availableHeight, viewportHeight * 0.6),
  };
}

function useModelPickerPanelGeometry(
  open: boolean,
  triggerRef: React.RefObject<HTMLDivElement | null>,
): ModelPickerPanelGeometry | null {
  const [geometry, setGeometry] = useState<ModelPickerPanelGeometry | null>(null);

  useEffect(() => {
    if (!open) return;

    const viewport = window.visualViewport;
    let animationFrame = 0;
    const update = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const triggerRect = trigger.getBoundingClientRect();
        setGeometry({
          triggerTop: triggerRect.top,
          triggerBottom: triggerRect.bottom,
          triggerLeft: triggerRect.left,
          triggerWidth: triggerRect.width,
          viewportTop: viewport?.offsetTop ?? 0,
          viewportLeft: viewport?.offsetLeft ?? 0,
          viewportWidth: viewport?.width ?? window.innerWidth,
          viewportHeight: viewport?.height ?? window.innerHeight,
          layoutHeight: window.innerHeight,
        });
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open, triggerRef]);

  return geometry;
}

interface ModelPickerProps {
  isMobile: boolean;
  options: ModelPickerOption[];
  value?: { provider: string; modelId: string } | null;
  onChange?: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
}

/** 模型选择器自行管理菜单状态，避免输入文字变化时重复构建完整模型菜单。 */
export const ModelPicker = memo(function ModelPicker({
  isMobile,
  options,
  value,
  onChange,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  isAutoSelection = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelGeometry = useModelPickerPanelGeometry(open, triggerRef);

  const locked = disabled || busy;
  const modelOptions = useMemo(() => [...options].sort(compareModelOptions), [options]);
  const filteredOptions = useMemo(() => filterModelOptions(modelOptions, filter), [filter, modelOptions]);
  const groups = useMemo(() => {
    const optionsByProvider = new Map<string, ModelPickerOption[]>();
    for (const option of filteredOptions) {
      const options = optionsByProvider.get(option.provider);
      if (options) options.push(option);
      else optionsByProvider.set(option.provider, [option]);
    }
    return Array.from(optionsByProvider, ([provider, options]) => ({ provider, options }));
  }, [filteredOptions]);
  const currentModelName = useMemo(() => {
    if (!value) return null;
    return modelOptions.find((option) => (
      option.modelId === value.modelId && option.provider === value.provider
    ))?.name ?? value.modelId;
  }, [value, modelOptions]);
  const currentName = selectedLabel ?? (value && currentModelName
    ? variant === "toolbar" ? `${truncateMiddle(value.provider, 18)}/${currentModelName}` : currentModelName
    : emptyLabel ?? (modelOptions.length > 0 ? "Select model" : "No models"));
  const panelLayout = panelGeometry
    ? calculateModelPickerPanelLayout(panelGeometry, isMobile, placement)
    : null;

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

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  const buttonStyle: React.CSSProperties = variant === "field"
    ? {
        display: "flex", alignItems: "center", gap: 7, width: "100%", minWidth: 0,
        height: 34, padding: "0 9px", overflow: "hidden", border: "1px solid var(--border)",
        borderRadius: 5, background: locked ? "var(--bg-panel)" : "var(--bg)",
        color: locked ? "var(--text-dim)" : "var(--text)", cursor: locked ? "default" : "pointer",
        fontSize: 12, textAlign: "left",
      }
    : {
        display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-start",
        padding: isMobile ? "4px 10px" : "8px 12px", height: isMobile ? 40 : 32,
        width: isMobile ? "100%" : undefined, maxWidth: isMobile ? "100%" : 220,
        overflow: "hidden", background: open ? "var(--bg-hover)" : "none",
        border: "none", borderRadius: 9, color: "var(--text-muted)",
        cursor: locked ? "not-allowed" : "pointer", fontSize: 12,
        opacity: locked ? 0.5 : 1, transition: "background 0.12s, color 0.12s",
      };

  if (!onChange) return null;

  return (
    <div ref={triggerRef} style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined, minWidth: 0 }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        onClick={() => {
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
        disabled={locked}
        style={buttonStyle}
        onMouseEnter={(event) => {
          if (locked) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : variant === "field" ? "var(--bg)" : "none";
          event.currentTarget.style.color = variant === "field" ? "var(--text)" : "var(--text-muted)";
        }}
        title={busy ? "Switching model" : locked ? currentName : modelOptions.length > 0 || onClear ? "Change model" : "No available models"}
      >
        {busy ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /></svg> : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>}
        <span style={{ flex: 1, overflow: "hidden", minWidth: 0, lineHeight: isMobile ? "14px" : undefined }}>
          {variant === "toolbar" && isMobile && value && currentModelName ? (
            <>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.provider}/</span>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentModelName}</span>
            </>
          ) : (
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentName}
            </span>
          )}
        </span>
        {variant === "field" && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}><polyline points="6 9 12 15 18 9" /></svg>}
      </button>
      {open && panelLayout && (
        <div ref={panelRef} role="listbox" aria-label={ariaLabel} style={{
          position: "fixed", ...panelLayout,
          zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "bottom" in panelLayout ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)", overflow: "hidden",
          display: "flex", flexDirection: "column",
          }}>
            {modelOptions.length > MODEL_FILTER_THRESHOLD && (
              <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <input value={filter} onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") { setFilter(""); setOpen(false); } }}
                  placeholder={t("chat.filterModels")} aria-label={t("chat.filterModels")} autoFocus={!isMobile} autoComplete="off" spellCheck={false}
                  style={{ width: "100%", minWidth: isMobile ? 0 : 220, fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }} />
              </div>
            )}
            <div style={{ minHeight: 0, overflowY: "auto" }}>
              {onClear && !filter.trim() && <ModelOptionButton active={!value} label={emptyLabel ?? "Default"} onClick={() => { setOpen(false); setFilter(""); onClear(); }} />}
              {groups.length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {filter.trim() ? t("chat.noMatchingModels") : "No available models"}
                </div>
              ) : groups.map((group, groupIndex) => (
                <div key={group.provider}>
                  {groups.length > 1 && <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", borderTop: groupIndex > 0 ? "1px solid var(--border)" : "none" }}>{group.provider}</div>}
                  {group.options.map((option) => {
                    const active = option.modelId === value?.modelId && option.provider === value?.provider;
                    return <ModelOptionButton key={`${option.provider}:${option.modelId}`} active={active} label={option.name} onClick={() => { setOpen(false); setFilter(""); if (!active || isAutoSelection) onChange(option.provider, option.modelId); }} />;
                  })}
                </div>
              ))}
            </div>
          </div>
      )}
    </div>
  );
});

function ModelOptionButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" role="option" aria-selected={active} onClick={onClick}
    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", background: active ? "var(--bg-selected)" : "none", border: "none", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left", fontWeight: active ? 600 : 400, whiteSpace: "nowrap" }}
    onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = "var(--bg-hover)"; }}
    onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = "none"; }}>
    {active ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg> : <span style={{ width: 10, flexShrink: 0 }} />}
    <span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
  </button>;
}
