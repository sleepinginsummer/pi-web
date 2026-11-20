"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import type { SessionStatsInfo } from "@/lib/pi-types";

export interface ContextUsageSnapshot {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

interface ContextUsageIndicatorProps {
  contextUsage?: ContextUsageSnapshot | null;
  sessionStats?: SessionStatsInfo | null;
  compact?: boolean;
}

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function computeCacheHitRate(stats: SessionStatsInfo | null | undefined): number | null {
  if (!stats) return null;
  const { input, cacheRead, cacheWrite } = stats.tokens;
  const totalInput = input + cacheRead + cacheWrite;
  if (totalInput <= 0 || cacheRead <= 0) return null;
  return (cacheRead / totalInput) * 100;
}

/**
 * 输入框右上角的上下文消耗环形指示器：
 * 悬停（移动端可点按）展示上下文窗口占比、缓存命中率与本会话总消耗。
 */
export const ContextUsageIndicator = memo(function ContextUsageIndicator({
  contextUsage,
  sessionStats,
  compact = false,
}: ContextUsageIndicatorProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinnedOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinnedOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pinnedOpen]);

  if (!contextUsage || contextUsage.contextWindow <= 0 || contextUsage.percent === null) {
    return null;
  }

  const pct = Math.max(0, Math.min(100, Math.round(contextUsage.percent)));
  const ringOffset = RING_CIRCUMFERENCE * (1 - pct / 100);
  const ringColor = pct >= 85 ? "#ef4444" : pct >= 70 ? "#d97706" : "currentColor";
  const barColor = pct >= 85 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#60a5fa";
  const usedLabel = contextUsage.tokens !== null ? formatCompactCount(contextUsage.tokens) : "—";
  const windowLabel = formatCompactCount(contextUsage.contextWindow);
  const cacheRate = computeCacheHitRate(sessionStats);
  const totalTokens = sessionStats && sessionStats.tokens.total > 0
    ? formatCompactCount(sessionStats.tokens.total)
    : null;
  const totalCost = sessionStats ? formatCostShort(sessionStats.cost) : null;
  const totalUsageLabel = [totalTokens, totalCost].filter(Boolean).join(" · ");
  const open = hovered || pinnedOpen;

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={t("chat.contextWindow")}
        aria-expanded={open}
        onClick={() => setPinnedOpen((prev) => !prev)}
        style={{
          height: compact ? 24 : 26,
          padding: compact ? "0 5px" : "0 7px",
          border: "none",
          borderRadius: 7,
          background: open ? "var(--bg-hover)" : "transparent",
          color: pct >= 70 ? ringColor : "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
          whiteSpace: "nowrap",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          style={{ transform: "rotate(-90deg)", flexShrink: 0 }}
        >
          <circle
            cx="7"
            cy="7"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.22"
            strokeWidth="2.1"
          />
          <circle
            cx="7"
            cy="7"
            r={RING_RADIUS}
            fill="none"
            stroke={ringColor}
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={ringOffset.toFixed(2)}
          />
        </svg>
        <span>{pct}%</span>
      </button>

      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: compact ? 0 : -18,
            width: 236,
            maxWidth: "calc(100vw - 32px)",
            padding: "10px 12px",
            borderRadius: 11,
            background: "#181a1f",
            color: "#f3f4f6",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
            zIndex: 110,
            fontSize: 12,
            lineHeight: 1.5,
            pointerEvents: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, color: "#9ca3af" }}>{t("chat.contextWindow")}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 650, color: "#ffffff" }}>
              {t("chat.contextUsed", { percent: pct })}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: "rgba(255, 255, 255, 0.12)", overflow: "hidden", marginBottom: 6 }}>
            <div style={{ height: "100%", width: `${pct}%`, borderRadius: 999, background: barColor }} />
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "#e5e7eb" }}>
            {t("chat.contextTokens", { used: usedLabel, window: windowLabel })}
          </div>

          {(cacheRate !== null || totalUsageLabel) && (
            <>
              <div style={{ height: 1, background: "rgba(255, 255, 255, 0.10)", margin: "7px 0" }} />
              {cacheRate !== null && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11.5, padding: "2px 0" }}>
                  <span style={{ color: "#9ca3af" }}>{t("chat.cacheHitRate")}</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "#f3f4f6", fontVariantNumeric: "tabular-nums" }}>
                    {cacheRate.toFixed(1)}%
                  </span>
                </div>
              )}
              {totalUsageLabel && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11.5, padding: "2px 0" }}>
                  <span style={{ color: "#9ca3af" }}>{t("chat.totalUsage")}</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "#f3f4f6", fontVariantNumeric: "tabular-nums" }}>
                    {totalUsageLabel}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
