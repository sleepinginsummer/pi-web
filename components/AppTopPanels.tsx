"use client";

import type { LocalePlugin } from "@/lib/i18n/types";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionContextUsage, SessionCopyField } from "@/lib/session-info-model";
import type { TopPanel, TopPanelPosition } from "@/hooks/useTopPanel";
import { SessionInfoPopover } from "./SessionInfoControls";

interface AppTopPanelsProps {
  activePanel: TopPanel | null;
  locale: string;
  onClose: () => void;
  onCopySessionField: (field: SessionCopyField, value: string) => void;
  onLocaleSelect: (locale: string) => void;
  position: TopPanelPosition | null;
  session: {
    contextUsage: SessionContextUsage;
    copiedField: SessionCopyField | null;
    isMobile: boolean;
    stats: SessionStatsInfo | null;
  };
  supportedLocales: LocalePlugin[];
  systemPrompt: string | null;
  translate: (key: string) => string;
}

export function AppTopPanels({
  activePanel,
  locale,
  onClose,
  onCopySessionField,
  onLocaleSelect,
  position,
  session,
  supportedLocales,
  systemPrompt,
  translate,
}: AppTopPanelsProps) {
  if (!activePanel || !position) return null;

  return (
    <div style={{ position: "fixed", top: position.top, left: position.left, width: position.width, maxHeight: `calc(100dvh - ${position.top}px)`, overflowY: "auto", zIndex: 500 }}>
      {activePanel === "language" && (
        <div role="menu" aria-label={translate("common.language")} style={{ background: "var(--bg-panel)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", overflow: "hidden", padding: 4 }}>
          {supportedLocales.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              onClick={() => {
                onLocaleSelect(plugin.id);
                onClose();
              }}
              role="menuitemradio"
              aria-checked={locale === plugin.id}
              style={{ display: "flex", alignItems: "center", width: "100%", height: 34, padding: "0 10px", border: "none", borderRadius: 4, background: locale === plugin.id ? "var(--bg-selected)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12 }}
            >
              <span>{plugin.label}</span>
            </button>
          ))}
        </div>
      )}
      {activePanel === "system" && (
        <div style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          {systemPrompt ? (
            <div style={{ maxHeight: "min(600px, 75vh)", overflowY: "auto", padding: "12px 16px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
              {systemPrompt}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {translate(systemPrompt === "" ? "system.empty" : "system.load")}
            </div>
          )}
        </div>
      )}
      {activePanel === "session" && (
        <div className="session-info-popover" style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)", padding: "12px 16px" }}>
          <SessionInfoPopover
            contextUsage={session.contextUsage}
            copiedSessionField={session.copiedField}
            isMobile={session.isMobile}
            locale={locale}
            onCopy={onCopySessionField}
            sessionStats={session.stats}
            translate={translate}
          />
        </div>
      )}
    </div>
  );
}
