"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { InputControlsMenu } from "./InputControlsMenu";
import { ContextUsageIndicator, type ContextUsageSnapshot } from "./ContextUsageIndicator";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { useI18n } from "@/hooks/useI18n";
import type { ModelSelectionViewActions, ModelSelectionViewState } from "@/lib/model-selection-types";
import { THINKING_LEVEL_OPTIONS, type ThinkingLevelOption } from "@/lib/thinking-levels";
import { Ellipsis, Zap } from "lucide-react";
import type { ToolPreset } from "@/lib/tool-presets";
import { getPresetFromToolNames, getToolNamesForPreset, missingBuiltinTools, SETTINGS_BUILTIN_TOOLS, TOOL_PRESET_VALUES, toolPresetLabelKey } from "@/lib/tool-presets";
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
  align?: "left" | "right";
}

export const ThinkingControl = memo(function ThinkingControl({ isMobile, modelState, isStreaming, onChange, align }: ThinkingControlProps) {
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
                    position: "absolute", bottom: "calc(100% + 6px)", ...(align === "left" ? { left: 0 } : isMobile ? { left: 0 } : { right: 0 }),
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

export const FastModeControl = memo(function FastModeControl({ isMobile, modelState, onChange }: FastModeControlProps) {
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
  /** 会话钉死的内置工具名单；null/undefined 表示跟随 settings.json。只用于标注被扩展接替的工具。 */
  pinnedToolNames?: readonly string[] | null;
  /** 拿不到会话的工具名单时（刚打开、没有存活运行时）为 false：不显示预设标签。 */
  toolSelectionKnown?: boolean;
  onChange?: (preset: ToolPreset, customNames?: string[] | null) => void;
  isStrayClick: (event: { detail: number }) => boolean;
  /** 运行中服务端会拒绝 set_tools：控件保留在原来的位置，只收起菜单并禁用点击。 */
  disabled?: boolean;
}

export const ToolPresetControl = memo(function ToolPresetControl({ isMobile, toolPreset, customToolNames, activeBuiltinTools, pinnedToolNames, toolSelectionKnown = true, onChange, isStrayClick, disabled = false }: ToolPresetControlProps) {
  const { t } = useI18n();
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const [configuredTools, setConfiguredTools] = useState<string[] | null>(null);
  useEffect(() => {
    // 设置里的名单既是 configured 的展示来源，也是"设置开着、本会话却没有"的对照基准。
    if (!toolDropdownOpen || configuredTools) return;
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
  }, [configuredTools, toolDropdownOpen]);
  // configured 展示设置本身（跟随它变化），其它预设展示预设名单；自定义勾选优先。
  const presetTools = toolPreset === "configured"
    ? (configuredTools ?? activeBuiltinTools)
    : getToolNamesForPreset(toolPreset ?? "default");
  // 名单未知（刚打开、没有存活运行时）时不假装有选择：勾选留空，chip 用中性名字。
  const selectedTools = toolSelectionKnown ? (customToolNames ?? presetTools) : undefined;
  // chip 与菜单行同一套英文短名（off/configured/read-only/default/full/custom），和旁边的推理级别保持风格一致。
  const toolPresetLabel = !toolSelectionKnown
    ? t("settings.builtinTools")
    : customToolNames
      ? t("chat.customToolSelection")
      : t(toolPresetLabelKey(toolPreset ?? "default"));
  // configured 的名单是全局设置（Settings › General 写 defaultTools）解析出来的，
  // 只能在那里改：这里仅作为"这个会话会拿到哪些工具"的展示，勾选不改写它。
  const followsSettings = toolPreset === "configured" && !customToolNames;
  // 设置里启用、这个会话却拿不到的工具：通常是扩展用自己的实现接替了它
  // （例如 pi-hashline-edit-pro 把 edit 换成 replace/insert）。没有钉死名单时会话
  // 想要的就是设置本身，所以那时用设置当对照。
  const missingHere = missingBuiltinTools(configuredTools, pinnedToolNames ?? configuredTools, activeBuiltinTools);
  useEffect(() => {
    if (!toolDropdownOpen) return;
    const close = (event: MouseEvent) => {
      if (!toolDropdownRef.current?.contains(event.target as Node)) setToolDropdownOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [toolDropdownOpen]);
  // 一轮开始时收起已打开的菜单，否则它会留在浮层里而每一项都点不动。
  useEffect(() => {
    if (disabled) setToolDropdownOpen(false);
  }, [disabled]);
  const onToolPresetChange = onChange;
  if (!onToolPresetChange) return null;
  return (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={(event) => { if (disabled || isStrayClick(event)) return; setToolDropdownOpen((open) => !open); }}
                   title={disabled ? t("chat.toolsLockedWhileRunning") : t("chat.changeToolPreset") + `: ${toolPresetLabel}`}
                   aria-label={t("chat.changeToolPreset")}
                   aria-disabled={disabled ? true : undefined}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: toolDropdownOpen && !disabled ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    opacity: disabled ? 0.5 : 1,
                    cursor: disabled ? "default" : "pointer",
                    fontSize: 12,
                                        transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                                if (disabled) return;
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
                {toolDropdownOpen && !disabled && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESET_LABELS.map((label) => {
                      const preset = presetForLabel(label);
                      const isActive = toolSelectionKnown && !customToolNames && (toolPreset ?? "default") === preset;
                      // 名字和 chip 共用一套译名；说明只是补充，和名字重复时不再重复显示。
                      const name = t(toolPresetLabelKey(preset));
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
                          <span style={{ flex: 1 }}>{name}</span>
                          {desc !== name && (
                            <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                          )}
                        </button>
                      );
                    })}
                    <div className="border-t border-border px-3 py-2" role="group" aria-label={t("settings.builtinTools")}>
                      {SETTINGS_BUILTIN_TOOLS.map((name) => (
                        <label key={name} className={`flex items-center gap-2 py-1 text-xs text-text-muted ${followsSettings ? "cursor-default" : "cursor-pointer"}`}>
                          <input
                            type="checkbox"
                            disabled={!selectedTools || followsSettings}
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
                          {missingHere.includes(name) && (
                            <span className="text-[10px] text-text-dim" title={t("chat.toolMissingTooltip")}>
                              · {t("chat.toolMissingHere")}
                            </span>
                          )}
                        </label>
                      ))}
                      {followsSettings && (
                        <p className="pt-1 text-[11px] leading-snug text-text-dim">{t("chat.toolsFollowSettingsHint")}</p>
                      )}
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

export const RunControls = memo(function RunControls({ isMobile, isStreaming, showLabel, onCompact, onAbortCompaction, isCompacting, onAbort, isStrayClick }: RunControlsProps) {
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

export const PreferenceToggles = memo(function PreferenceToggles({ isMobile, soundEnabled, onSoundToggle, notificationEnabled, notificationPermission, onNotificationToggle }: PreferenceTogglesProps) {
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
  pinnedToolNames?: readonly string[] | null;
  toolSelectionKnown?: boolean;
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
  endAction?: React.ReactNode;
}

/** 输入控制栏自行管理下拉菜单，输入文字变化时无需重建控制栏。 */
export const InputControls = memo(function InputControls({
  isMobile, isStreaming, modelState, modelActions, onThinkingLevelChange, toolPreset, customToolNames, activeBuiltinTools, pinnedToolNames, toolSelectionKnown, onToolPresetChange,
  onCompact, onAbortCompaction, isCompacting, onAbort, soundEnabled, onSoundToggle,
  notificationEnabled, notificationPermission, onNotificationToggle,
  endAction,
}: InputControlsProps) {
  // Stop 在运行结束时被 Compact/工具按钮替换，结束后的短时间内的点击视为误触。
  const isStrayClick = useRunEndStrayClick(isStreaming);

  // 移动端：输入行只留暂存库。Stop / 压缩都在「更多」里——它们贴着手边，暴露在外
  // 一路滑动就容易误触，停掉一次运行或触发一次压缩。
  if (isMobile) {
    return (
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
        {endAction}
      </div>
    );
  }

  return (
    <>
          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: "auto",
          }}>
            <InputControlsMenu
              isMobile={false}
              isOpen={false}
              onClose={() => {}}
              modelControls={(
                <>
                  <ThinkingControl isMobile={false} modelState={modelState} isStreaming={isStreaming} onChange={onThinkingLevelChange} />
                  {!isStreaming && <FastModeControl isMobile={false} modelState={modelState} onChange={modelActions.changeFastEnabled} />}
                  <ToolPresetControl isMobile={false} toolPreset={toolPreset} customToolNames={customToolNames} activeBuiltinTools={activeBuiltinTools} pinnedToolNames={pinnedToolNames} toolSelectionKnown={toolSelectionKnown} onChange={onToolPresetChange} isStrayClick={isStrayClick} disabled={isStreaming} />
                </>
              )}
              runControls={(
                <RunControls
                  isMobile={false}
                  isStreaming={isStreaming}
                  showLabel
                  onCompact={onCompact}
                  onAbortCompaction={onAbortCompaction}
                  isCompacting={isCompacting}
                  onAbort={onAbort}
                  isStrayClick={isStrayClick}
                />
              )}
              preferenceControls={(
                <PreferenceToggles
                  isMobile={false}
                  soundEnabled={soundEnabled}
                  onSoundToggle={onSoundToggle}
                  notificationEnabled={notificationEnabled}
                  notificationPermission={notificationPermission}
                  onNotificationToggle={onNotificationToggle}
                />
              )}
            />
            {endAction}
          </div>
    </>
  );
});


/**
 * 移动端输入框右上角的「更多」：工具预设、Fast、压缩、提示音、通知。
 *
 * 思考强度不在菜单里——它和模型名称一起常驻输入框下方那一行，运行中那一行只留给
 * 模型名称和 Stop，所以菜单按钮挪到输入框上方，不再占下方空间。
 */
export const MobileComposerMenu = memo(function MobileComposerMenu({
  isStreaming, modelState, modelActions, toolPreset, customToolNames, activeBuiltinTools, pinnedToolNames,
  toolSelectionKnown, onToolPresetChange, onCompact, onAbortCompaction, isCompacting, onAbort,
  soundEnabled, onSoundToggle, notificationEnabled, notificationPermission, onNotificationToggle,
}: Omit<InputControlsProps, "isMobile" | "endAction">) {
  const { t } = useI18n();
  const isStrayClick = useRunEndStrayClick(isStreaming);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () => document.removeEventListener("pointerdown", handleOutsideClick);
  }, []);
  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button type="button" className="mobile-composer-more is-compact" aria-label={t("chat.moreControls")}
        aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Ellipsis size={17} aria-hidden="true" />{t("chat.mobileMore")}
        {(isStreaming || isCompacting) && (
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: isCompacting ? "#ef4444" : "var(--accent)" }} />
        )}
      </button>
      <InputControlsMenu
        isMobile
        isOpen={open}
        onClose={() => {
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>(".mobile-composer-more")?.focus();
        }}
        modelControls={(
          <>
            {!isStreaming && <FastModeControl isMobile modelState={modelState} onChange={modelActions.changeFastEnabled} />}
            <ToolPresetControl isMobile toolPreset={toolPreset} customToolNames={customToolNames} activeBuiltinTools={activeBuiltinTools} pinnedToolNames={pinnedToolNames} toolSelectionKnown={toolSelectionKnown} onChange={onToolPresetChange} isStrayClick={isStrayClick} disabled={isStreaming} />
          </>
        )}
        runControls={(
          <RunControls
            isMobile
            isStreaming={isStreaming}
            showLabel
            onCompact={onCompact && (() => { setOpen(false); onCompact(); })}
            onAbortCompaction={onAbortCompaction && (() => { setOpen(false); onAbortCompaction(); })}
            isCompacting={isCompacting}
            onAbort={() => { setOpen(false); onAbort(); }}
            isStrayClick={isStrayClick}
          />
        )}
        preferenceControls={(
          <PreferenceToggles
            isMobile
            soundEnabled={soundEnabled}
            onSoundToggle={onSoundToggle}
            notificationEnabled={notificationEnabled}
            notificationPermission={notificationPermission}
            onNotificationToggle={onNotificationToggle}
          />
        )}
      />
    </div>
  );
});

interface ComposerTopUtilitiesProps {
  isStreaming: boolean;
  contextUsage?: ContextUsageSnapshot | null;
  sessionStats?: SessionStatsInfo | null;
  toolPreset?: ToolPreset;
  customToolNames?: readonly string[] | null;
  activeBuiltinTools?: readonly string[];
  pinnedToolNames?: readonly string[] | null;
  toolSelectionKnown?: boolean;
  onToolPresetChange?: (preset: ToolPreset, customNames?: string[] | null) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  notificationEnabled?: boolean;
  notificationPermission?: NotificationPermission | "unsupported";
  onNotificationToggle?: () => void;
  endAction?: React.ReactNode;
}

/**
 * 桌面端输入框右上角工具条：
 * 上下文消耗环 · 工具预设 · 压缩/停止压缩 · 提示音 · 桌面通知 · 消息暂存库。
 */
export const ComposerTopUtilities = memo(function ComposerTopUtilities({
  isStreaming,
  contextUsage,
  sessionStats,
  toolPreset,
  customToolNames,
  activeBuiltinTools,
  pinnedToolNames,
  toolSelectionKnown,
  onToolPresetChange,
  onCompact,
  onAbortCompaction,
  isCompacting,
  soundEnabled,
  onSoundToggle,
  notificationEnabled,
  notificationPermission,
  onNotificationToggle,
  endAction,
}: ComposerTopUtilitiesProps) {
  const isStrayClick = useRunEndStrayClick(isStreaming);
  return (
    <div
      className="composer-top-utils"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 2,
      }}
    >
      <ContextUsageIndicator contextUsage={contextUsage} sessionStats={sessionStats} />
      <ToolPresetControl
        isMobile={false}
        toolPreset={toolPreset}
        customToolNames={customToolNames}
        activeBuiltinTools={activeBuiltinTools}
        pinnedToolNames={pinnedToolNames}
        toolSelectionKnown={toolSelectionKnown}
        onChange={onToolPresetChange}
        isStrayClick={isStrayClick}
        disabled={isStreaming}
      />
      {(!isStreaming || isCompacting) && onCompact && (
        <RunControls
          isMobile={false}
          isStreaming={false}
          showLabel
          onCompact={onCompact}
          onAbortCompaction={onAbortCompaction}
          isCompacting={isCompacting}
          onAbort={() => {}}
          isStrayClick={isStrayClick}
        />
      )}
      <PreferenceToggles
        isMobile={false}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        notificationEnabled={notificationEnabled}
        notificationPermission={notificationPermission}
        onNotificationToggle={onNotificationToggle}
      />
      {endAction}
    </div>
  );
});

export const ComposerStopButton = memo(function ComposerStopButton({
  onAbort,
}: {
  onAbort: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onAbort}
      title={t("chat.stopAgent")}
      aria-label={t("chat.stopAgent")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 13px",
        height: 32,
        background: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: 9,
        color: "#ef4444",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
        letterSpacing: "-0.01em",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
      </svg>
      {t("chat.stop")}
    </button>
  );
});
