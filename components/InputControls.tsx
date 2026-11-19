"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { InputControlsMenu } from "./InputControlsMenu";
import { useI18n } from "@/hooks/useI18n";
import type { ModelSelectionViewActions, ModelSelectionViewState } from "@/lib/model-selection-types";
import { THINKING_LEVEL_OPTIONS, type ThinkingLevelOption } from "@/lib/thinking-levels";
import { Ellipsis, Zap } from "lucide-react";
import type { ToolPreset } from "@/lib/tool-presets";
import { getPresetFromToolNames, getToolNamesForPreset, SETTINGS_BUILTIN_TOOLS, TOOL_PRESET_VALUES } from "@/lib/tool-presets";
import { useRunEndStrayClick } from "@/lib/run-end-click";
const TOOL_PRESET_LABELS = ["off", ...TOOL_PRESET_VALUES.filter((preset) => preset !== "none")] as const;
type ToolPresetLabel = typeof TOOL_PRESET_LABELS[number];

function presetForLabel(label: ToolPresetLabel): ToolPreset {
  return label === "off" ? "none" : label;
}
const THINKING_LEVEL_DESC_KEYS: Record<ThinkingLevelOption, string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};


interface ThinkingControlProps {
  isMobile: boolean;
  modelState: ModelSelectionViewState;
  isStreaming: boolean;
  onChange?: (level: ThinkingLevelOption) => void;
}

const ThinkingControl = memo(function ThinkingControl({ isMobile, modelState, isStreaming, onChange }: ThinkingControlProps) {
  const { t } = useI18n();
  const { thinkingLevel, isAutoThinkingSelection, availableThinkingLevels, thinkingLevelMap } = modelState;
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDisplayLabel = (() => {
    const level = thinkingLevel ?? "auto";
    if (level === "auto" || !thinkingLevelMap) return level;
    return thinkingLevelMap[level] ?? level;
  })();
  const displayedThinkingLabel = isStreaming && modelState.fastEnabled
    ? `${thinkingDisplayLabel} + Fast`
    : thinkingDisplayLabel;
  useEffect(() => {
    if (!thinkingDropdownOpen) return;
    const close = (event: MouseEvent) => {
      if (!thinkingDropdownRef.current?.contains(event.target as Node)) setThinkingDropdownOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [thinkingDropdownOpen]);
  const onThinkingLevelChange = onChange;
  return (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setThinkingDropdownOpen((open) => !open)}
                  disabled={!onThinkingLevelChange}
                   title={t(isStreaming ? "chat.currentReasoning" : "chat.changeReasoning", { level: displayedThinkingLabel })}
                   aria-label={t("chat.changeReasoningLabel")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                                        transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                                e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{displayedThinkingLabel}</span>
                </button>
                {thinkingDropdownOpen && !isStreaming && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", ...(isMobile ? { left: 0 } : { right: 0 }),
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVEL_OPTIONS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = lvl === "auto"
                        ? isAutoThinkingSelection
                        : !isAutoThinkingSelection && thinkingLevel === lvl;
                       const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive || isAutoThinkingSelection) onThinkingLevelChange?.(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

  );
});

interface FastModeControlProps {
  isMobile: boolean;
  modelState: ModelSelectionViewState;
  onChange?: (enabled: boolean) => void;
}

const FastModeControl = memo(function FastModeControl({ isMobile, modelState, onChange }: FastModeControlProps) {
  const { t } = useI18n();
  if (!modelState.fastAvailable || !onChange) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={modelState.fastEnabled}
      disabled={modelState.fastPending}
      title={t(modelState.fastEnabled ? "chat.fastDisable" : "chat.fastEnable")}
      onClick={() => onChange(!modelState.fastEnabled)}
      style={{
        display: "flex", alignItems: "center", gap: 5, height: 32,
        padding: isMobile ? "0 7px" : "8px 10px", border: "none", borderRadius: 9,
        background: modelState.fastEnabled ? "var(--bg-selected)" : "none",
        color: modelState.fastEnabled ? "var(--accent)" : "var(--text-muted)",
        cursor: modelState.fastPending ? "wait" : "pointer", fontSize: 12,
      }}
    >
      <Zap size={13} aria-hidden="true" />
      <span style={{ whiteSpace: "nowrap" }}>{t("chat.fast")}</span>
    </button>
  );
});

interface ToolPresetControlProps {
  isMobile: boolean;
  toolPreset?: ToolPreset;
  customToolNames?: readonly string[] | null;
  activeBuiltinTools?: readonly string[];
  onChange?: (preset: ToolPreset, customNames?: string[] | null) => void;
  isStrayClick: (event: { detail: number }) => boolean;
}

const ToolPresetControl = memo(function ToolPresetControl({ isMobile, toolPreset, customToolNames, activeBuiltinTools, onChange, isStrayClick }: ToolPresetControlProps) {
  const { t } = useI18n();
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const [configuredTools, setConfiguredTools] = useState<string[] | null>(null);
  useEffect(() => {
    if (!toolDropdownOpen || toolPreset !== "configured" || activeBuiltinTools) return;
    const controller = new AbortController();
    void fetch("/api/tools/settings", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { builtinTools: string[] };
        if (!controller.signal.aborted) setConfiguredTools(data.builtinTools);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error("[pi-web] 无法读取内置工具默认设置", error);
      });
    return () => controller.abort();
  }, [activeBuiltinTools, toolDropdownOpen, toolPreset]);
  const selectedTools = customToolNames ?? getToolNamesForPreset(toolPreset ?? "default") ?? activeBuiltinTools ?? configuredTools;
  const toolPresetLabel = toolPreset === "none" ? "off" : (customToolNames ? t("chat.customToolSelection") : toolPreset ?? "default");
  useEffect(() => {
    if (!toolDropdownOpen) return;
    const close = (event: MouseEvent) => {
      if (!toolDropdownRef.current?.contains(event.target as Node)) setToolDropdownOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [toolDropdownOpen]);
  const onToolPresetChange = onChange;
  if (!onToolPresetChange) return null;
  return (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={(event) => { if (!isStrayClick(event)) setToolDropdownOpen((open) => !open); }}
                   title={t("chat.changeToolPreset") + `: ${toolPresetLabel}`}
                   aria-label={t("chat.changeToolPreset")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                                        transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                                e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESET_LABELS.map((label) => {
                      const preset = presetForLabel(label);
                      const isActive = !customToolNames && (toolPreset ?? "default") === preset;
                      let desc: string;
                      if (label === "off") desc = t("chat.noTools");
                      // configured 不钉死工具列表，由 settings.json 的 defaultTools 解析
                      else if (label === "configured") desc = t("chat.configuredTools");
                      else if (label === "read-only") desc = t("chat.readOnlyTools", { count: 4 });
                      else if (label === "default") desc = t("chat.builtInTools", { count: 4 });
                      else desc = t("chat.allBuiltInTools");
                      return (
                        <button
                          key={label}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{label}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                    <div className="border-t border-border px-3 py-2" role="group" aria-label={t("settings.builtinTools")}>
                      {SETTINGS_BUILTIN_TOOLS.map((name) => (
                        <label key={name} className="flex cursor-pointer items-center gap-2 py-1 text-xs text-text-muted">
                          <input
                            type="checkbox"
                            disabled={!selectedTools}
                            checked={selectedTools?.includes(name) ?? false}
                            onChange={(event) => {
                              if (!selectedTools) return;
                              const next = event.target.checked ? [...selectedTools, name] : selectedTools.filter((tool) => tool !== name);
                              const preset = getPresetFromToolNames(next);
                              const names = getToolNamesForPreset(preset);
                              const matches = names?.length === next.length && next.every((tool) => names.includes(tool));
                              onToolPresetChange(preset, matches ? null : next);
                            }}
                          />
                          {name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

  );
});


interface RunControlsProps {
  isMobile: boolean;
  isStreaming: boolean;
  showLabel: boolean;
  isStrayClick: (event: { detail: number }) => boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  onAbort: () => void;
}

const RunControls = memo(function RunControls({ isMobile, isStreaming, showLabel, onCompact, onAbortCompaction, isCompacting, onAbort, isStrayClick }: RunControlsProps) {
  const { t } = useI18n();
  return (
    <>
            {(!isStreaming || isCompacting) && onCompact && (
              <div>
                <button
                  onClick={isCompacting ? onAbortCompaction : (event) => { if (!isStrayClick(event)) onCompact?.(); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                   title={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                   className={isMobile && isCompacting ? "mobile-composer-stop" : undefined}
                   aria-label={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{showLabel && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span>}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{showLabel && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span>}</>
                  )}
                </button>
              </div>
            )}

            {isStreaming && (
              <>
                <button
                onClick={onAbort}
                 title={t("chat.stopAgent")} aria-label={t("chat.stopAgent")} className={isMobile ? "mobile-composer-stop" : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                 {showLabel && t("chat.stop")}
              </button>
              </>
            )}


    </>
  );
});

interface PreferenceTogglesProps {
  isMobile: boolean;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  notificationEnabled?: boolean;
  notificationPermission?: NotificationPermission | "unsupported";
  onNotificationToggle?: () => void;
}

const PreferenceToggles = memo(function PreferenceToggles({ isMobile, soundEnabled, onSoundToggle, notificationEnabled, notificationPermission, onNotificationToggle }: PreferenceTogglesProps) {
  const { t } = useI18n();
  return (
    <>
            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                 title={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                 aria-label={soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  width: isMobile ? 32 : 32,
                  height: 32,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
            {onNotificationToggle !== undefined && notificationPermission !== "unsupported" && (
              <button
                onClick={onNotificationToggle}
                title={notificationEnabled
                  ? t("chat.disableNotification")
                  : notificationPermission === "denied"
                    ? t("chat.notificationBlocked")
                    : t("chat.enableNotification")}
                aria-label={notificationEnabled
                  ? t("chat.disableNotification")
                  : notificationPermission === "denied"
                    ? t("chat.notificationBlocked")
                    : t("chat.enableNotification")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32,
                  height: 32,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: notificationEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: notificationEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = notificationEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = notificationEnabled ? "1" : "0.55";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  {!notificationEnabled && <line x1="4" y1="4" x2="20" y2="20" />}
                </svg>
              </button>
            )}

    </>
  );
});

interface InputControlsProps {
  isMobile: boolean;
  isStreaming: boolean;
  modelState: ModelSelectionViewState;
  modelActions: ModelSelectionViewActions;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  toolPreset?: ToolPreset;
  customToolNames?: readonly string[] | null;
  activeBuiltinTools?: readonly string[];
  onToolPresetChange?: (preset: ToolPreset, customNames?: string[] | null) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  onAbort: () => void;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  notificationEnabled?: boolean;
  notificationPermission?: NotificationPermission | "unsupported";
  onNotificationToggle?: () => void;
}

/** 输入控制栏自行管理下拉菜单，输入文字变化时无需重建控制栏。 */
export const InputControls = memo(function InputControls({
  isMobile, isStreaming, modelState, modelActions, onThinkingLevelChange, toolPreset, customToolNames, activeBuiltinTools, onToolPresetChange,
  onCompact, onAbortCompaction, isCompacting, onAbort, soundEnabled, onSoundToggle,
  notificationEnabled, notificationPermission, onNotificationToggle,
}: InputControlsProps) {
  const { t } = useI18n();
  // Stop 在运行结束时被 Compact/工具按钮替换，结束后的短时间内的点击视为误触。
  const isStrayClick = useRunEndStrayClick(isStreaming);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(target)) setControlsMenuOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () => document.removeEventListener("pointerdown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);

  return (
    <>
          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: isMobile ? 0 : "auto",
          }}>
            {isMobile && (isStreaming || isCompacting) && (
              <RunControls isMobile isStreaming={isStreaming} showLabel={false} onCompact={onCompact}
                onAbortCompaction={onAbortCompaction} isCompacting={isCompacting} onAbort={onAbort} isStrayClick={isStrayClick} />
            )}
            {isMobile && (
              <button type="button" className="mobile-composer-more" aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen} onClick={() => setControlsMenuOpen((open) => !open)}>
                <Ellipsis size={17} aria-hidden="true" />{t("chat.mobileMore")}
              </button>
            )}
            <InputControlsMenu
              isMobile={isMobile}
              isOpen={controlsMenuOpen}
              onClose={() => { setControlsMenuOpen(false); controlsMenuRef.current?.querySelector<HTMLButtonElement>(".mobile-composer-more")?.focus(); }}
              modelControls={(!isMobile || controlsMenuOpen) ? (
                <>
                  <ThinkingControl isMobile={isMobile} modelState={modelState} isStreaming={isStreaming} onChange={onThinkingLevelChange} />
                  {!isStreaming && <FastModeControl isMobile={isMobile} modelState={modelState} onChange={modelActions.changeFastEnabled} />}
                  {!isStreaming && <ToolPresetControl isMobile={isMobile} toolPreset={toolPreset} customToolNames={customToolNames} activeBuiltinTools={activeBuiltinTools} onChange={onToolPresetChange} isStrayClick={isStrayClick} />}
                </>
              ) : null}
              runControls={(!isMobile || (!isStreaming && !isCompacting)) ? (
                <RunControls
                  isMobile={isMobile}
                  isStreaming={isStreaming}
                  showLabel={!isMobile || controlsMenuOpen}
                  onCompact={onCompact}
                  onAbortCompaction={onAbortCompaction}
                  isCompacting={isCompacting}
                  onAbort={onAbort}
                  isStrayClick={isStrayClick}
                />
              ) : null}
              preferenceControls={(
                <PreferenceToggles
                  isMobile={isMobile}
                  soundEnabled={soundEnabled}
                  onSoundToggle={onSoundToggle}
                  notificationEnabled={notificationEnabled}
                  notificationPermission={notificationPermission}
                  onNotificationToggle={onNotificationToggle}
                />
              )}
            />
          </div>
    </>
  );
});
