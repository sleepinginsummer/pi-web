"use client";

import { memo } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";
import { SessionSwitchTrack } from "./SessionSwitchTrack";

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
      className={`top-bar-toggle${enabled ? " is-on" : ""}${compact ? " is-compact" : ""}`}
      style={{
        opacity: available ? 1 : 0.45,
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
      <SessionSwitchTrack checked={enabled} pending={pending} />
    </button>
  );
});
