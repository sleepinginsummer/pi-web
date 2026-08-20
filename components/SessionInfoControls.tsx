"use client";

import type { SessionStatsInfo } from "@/lib/pi-types";

import {
  buildSessionInfoModel,
  formatCompact,
  type SessionContextUsage as ContextUsage,
  type SessionCopyField,
  type SessionDetailRow as SessionInfoRow,
  type SessionInfoRow as InfoRow,
} from "@/lib/session-info-model";

type Translate = (key: string) => string;

function InfoSection({
  align = "left",
  compact = false,
  rows,
  title,
}: {
  align?: "left" | "right";
  compact?: boolean;
  rows: InfoRow[];
  title: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)", columnGap: compact ? 14 : 12, rowGap: 4, justifyContent: compact ? "start" : undefined }}>
        {rows.map(({ label, value }) => (
          <div key={`${title}:${label}`} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
            <div style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: compact ? "normal" : "anywhere", textAlign: align, whiteSpace: align === "right" ? "nowrap" : "normal" }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ copied, field, onCopy, translate, value }: {
  copied: boolean;
  field: SessionCopyField;
  onCopy: (field: SessionCopyField, value: string) => void;
  translate: Translate;
  value: string;
}) {
  return (
    <button
      type="button"
      title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
      onClick={() => onCopy(field, value)}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, marginTop: -2, color: copied ? "var(--accent)" : "var(--text-dim)", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

function SessionDetailsSection({ copiedSessionField, onCopy, rows, translate }: {
  copiedSessionField: SessionCopyField | null;
  onCopy: (field: SessionCopyField, value: string) => void;
  rows: SessionInfoRow[];
  translate: Translate;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
        {rows.map((row) => (
          <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
            <div style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>{row.value}</div>
            <div>{row.copyField ? <CopyButton copied={copiedSessionField === row.copyField} field={row.copyField} onCopy={onCopy} translate={translate} value={row.value} /> : null}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface SessionStatsButtonProps {
  active: boolean;
  contextUsage: ContextUsage;
  isMobile: boolean;
  locale: string;
  onClick: () => void;
  rightPanelOpen: boolean;
  sessionStats: SessionStatsInfo | null;
  translate: Translate;
}

export function SessionStatsButton({ active, contextUsage, isMobile, locale, onClick, rightPanelOpen, sessionStats, translate }: SessionStatsButtonProps) {
  const tokens = sessionStats?.tokens;
  const cost = sessionStats?.cost ?? 0;
  const contextPercent = contextUsage?.percent;
  const contextColor = contextPercent !== null && contextPercent !== undefined && contextPercent > 90
    ? "#ef4444"
    : contextPercent !== null && contextPercent !== undefined && contextPercent > 70 ? "rgba(234,179,8,0.95)" : "var(--text-muted)";
  const contextLabel = contextUsage?.contextWindow
    ? `${contextPercent !== null ? contextPercent?.toFixed(0) : "?"}% / ${formatCompact(contextUsage.contextWindow)}`
    : null;
  const tooltip = tokens ? [
    `in: ${tokens.input.toLocaleString(locale)}`,
    `out: ${tokens.output.toLocaleString(locale)}`,
    `cache read: ${tokens.cacheRead.toLocaleString(locale)}`,
    `cache write: ${tokens.cacheWrite.toLocaleString(locale)}`,
    ...(cost > 0 ? [`cost: $${cost.toFixed(4)}`] : []),
  ].join("  |  ") : translate("session.title");

  return (
    <button type="button" onClick={onClick} title={tooltip} aria-label={translate("session.title")} aria-pressed={active} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: rightPanelOpen ? 12 : 48, height: "100%", background: active ? "var(--bg-selected)" : "none", border: "none", borderTop: active ? "2px solid var(--accent)" : "2px solid transparent", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", cursor: "pointer", fontVariantNumeric: "tabular-nums" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
      {!isMobile && tokens && tokens.input > 0 && <span>in {formatCompact(tokens.input)}</span>}
      {!isMobile && tokens && tokens.output > 0 && <span>out {formatCompact(tokens.output)}</span>}
      {!isMobile && tokens && tokens.cacheRead > 0 && <span>cache {formatCompact(tokens.cacheRead)}</span>}
      {!isMobile && cost > 0 && <span style={{ color: "var(--text)", fontWeight: 500 }}>{cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01"}</span>}
      {contextLabel && <span style={{ color: contextColor }}>{contextLabel}</span>}
    </button>
  );
}

interface SessionInfoPopoverProps {
  contextUsage: ContextUsage;
  copiedSessionField: SessionCopyField | null;
  isMobile: boolean;
  locale: string;
  onCopy: (field: SessionCopyField, value: string) => void;
  sessionStats: SessionStatsInfo | null;
  translate: Translate;
}

export function SessionInfoPopover({ contextUsage, copiedSessionField, isMobile, locale, onCopy, sessionStats, translate }: SessionInfoPopoverProps) {
  if (!sessionStats) return <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>{translate("session.load")}</div>;
  const model = buildSessionInfoModel(sessionStats, contextUsage, locale, translate);
  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)", gap: isMobile ? 16 : 24, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
      <SessionDetailsSection copiedSessionField={copiedSessionField} onCopy={onCopy} rows={model.sessionRows} translate={translate} />
      <InfoSection rows={model.messageRows} title={translate("session.messages")} />
      <InfoSection align="right" compact rows={model.tokenRows} title={translate("session.tokens")} />
    </div>
  );
}
