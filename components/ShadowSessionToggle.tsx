"use client";

import { memo } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";

export const ShadowSessionToggle = memo(function ShadowSessionToggle({
  enabled,
  pending,
  available,
  onToggle,
  compact = false,
}: Omit<ShadowSessionControl, "sessionId" | "scopeKey"> & { compact?: boolean }) {
  const { t } = useI18n();
  const disabled = !available || pending;
  const title = !available
    ? t("shadow.sessionUnavailable")
    : enabled
      ? t("shadow.disableSession")
      : t("shadow.enableSession");

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={enabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: "100%",
        padding: compact ? "0 9px" : "0 12px",
        border: "none",
        borderTop: "2px solid transparent",
        borderRight: "1px solid var(--border)",
        background: "none",
        color: enabled ? "var(--text-muted)" : "var(--text-dim)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: available ? 1 : 0.45,
        fontSize: 11,
        whiteSpace: "nowrap",
        transition: "color 0.15s, background 0.15s, opacity 0.15s",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ color: enabled ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M8 11c-2 1-3 3-3 5M10 12c-1 2-1 4 0 6M14 12c1 2 1 4 0 6M16 11c2 1 3 3 3 5" />
      </svg>
      {!compact && <span>{t("shadow.label")}</span>}
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          width: 24,
          height: 14,
          borderRadius: 999,
          background: enabled ? "var(--accent)" : "var(--border)",
          opacity: pending ? 0.55 : 1,
          transition: "background 0.15s, opacity 0.15s",
        }}
      >
        <span style={{
          position: "absolute",
          top: 2,
          left: enabled ? 12 : 2,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "var(--bg-panel)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.22)",
          transition: "left 0.15s",
        }} />
      </span>
    </button>
  );
});
