import type { SessionStatsInfo } from "./pi-types";

export type SessionContextUsage = { percent: number | null; contextWindow: number; tokens: number | null } | null;
export type SessionCopyField = "file" | "id";
export type SessionInfoRow = { label: string; value: string };
export type SessionDetailRow = SessionInfoRow & { copyField: SessionCopyField | null };

export interface SessionInfoModel {
  sessionRows: SessionDetailRow[];
  messageRows: SessionInfoRow[];
  tokenRows: SessionInfoRow[];
}

type Translate = (key: string) => string;

export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

export function buildSessionInfoModel(
  sessionStats: SessionStatsInfo,
  contextUsage: SessionContextUsage,
  locale: string,
  translate: Translate,
): SessionInfoModel {
  const context = contextUsage ?? sessionStats.contextUsage;
  return {
    sessionRows: [
      ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
      { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" },
      { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" },
    ],
    messageRows: [
      { label: translate("session.user"), value: sessionStats.userMessages.toLocaleString(locale) },
      { label: translate("session.assistant"), value: sessionStats.assistantMessages.toLocaleString(locale) },
      { label: translate("session.toolCalls"), value: sessionStats.toolCalls.toLocaleString(locale) },
      { label: translate("session.toolResults"), value: sessionStats.toolResults.toLocaleString(locale) },
      { label: translate("session.total"), value: sessionStats.totalMessages.toLocaleString(locale) },
    ],
    tokenRows: [
      { label: translate("session.input"), value: sessionStats.tokens.input.toLocaleString(locale) },
      { label: translate("session.output"), value: sessionStats.tokens.output.toLocaleString(locale) },
      ...(sessionStats.tokens.cacheRead > 0 ? [{ label: translate("session.cacheRead"), value: sessionStats.tokens.cacheRead.toLocaleString(locale) }] : []),
      ...(sessionStats.tokens.cacheWrite > 0 ? [{ label: translate("session.cacheWrite"), value: sessionStats.tokens.cacheWrite.toLocaleString(locale) }] : []),
      ...(
        sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0
        && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
          ? [{
              label: translate("session.cacheHitRate"),
              value: `${(
                sessionStats.tokens.cacheRead
                / (
                  sessionStats.tokens.cacheRead
                  + sessionStats.tokens.cacheWrite
                  + sessionStats.tokens.input
                )
                * 100
              ).toFixed(1)}%`,
            }]
          : []
      ),
      { label: translate("session.total"), value: sessionStats.tokens.total.toLocaleString(locale) },
      ...(sessionStats.cost > 0 ? [{ label: translate("session.cost"), value: `$${sessionStats.cost.toFixed(4)}` }] : []),
      ...(context?.contextWindow ? [{ label: translate("session.context"), value: `${context.percent !== null ? `${context.percent.toFixed(1)}%` : "?"} / ${formatCompact(context.contextWindow)}` }] : []),
    ],
  };
}
