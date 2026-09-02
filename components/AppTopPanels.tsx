"use client";

import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionContextUsage, SessionCopyField } from "@/lib/session-info-model";
import type { TopPanel, TopPanelPosition } from "@/hooks/useTopPanel";
import { SessionInfoPopover } from "./SessionInfoControls";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import type { SessionFamily } from "@/lib/session-family";
import type { SessionInfo } from "@/lib/types";
import type { ToolEntry } from "@/lib/tool-presets";

interface AppTopPanelsProps {
  activePanel: TopPanel | null;
  agentFamily: SessionFamily | null;
  locale: string;
  onCopySessionField: (field: SessionCopyField, value: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  position: TopPanelPosition | null;
  runningSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  session: {
    contextUsage: SessionContextUsage;
    copiedField: SessionCopyField | null;
    isMobile: boolean;
    stats: SessionStatsInfo | null;
    selectedSession: SessionInfo | null;
  };
  systemPrompt: string | null;
  systemPromptLoading: boolean;
  tools: ToolEntry[] | null;
  toolsLoading: boolean;
  translate: (key: string) => string;
}

export function AppTopPanels({
  activePanel,
  agentFamily,
  locale,
  onCopySessionField,
  onSelectSession,
  position,
  runningSessionIds,
  selectedSessionId,
  session,
  systemPrompt,
  systemPromptLoading,
  tools,
  toolsLoading,
  translate,
}: AppTopPanelsProps) {
  if (!activePanel || !position) return null;

  return (
    <div style={{ position: "fixed", top: position.top, left: position.left, width: position.width, maxHeight: `calc(100dvh - ${position.top}px)`, overflowY: "auto", zIndex: 500 }}>
      {activePanel === "system" && (
        <SystemPromptPanel loading={systemPromptLoading} prompt={systemPrompt} translate={translate} />
      )}
      {activePanel === "tools" && (
        <ToolDefinitionsPanel loading={toolsLoading} tools={tools} translate={translate} />
      )}
      {activePanel === "agents" && agentFamily && selectedSessionId && (
        <AgentSessionPanel
          rootSession={agentFamily.root}
          subagents={agentFamily.subagents}
          selectedSessionId={selectedSessionId}
          runningSessionIds={runningSessionIds}
          onSelectSession={onSelectSession}
        />
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
            selectedSession={session.selectedSession}
            translate={translate}
          />
        </div>
      )}
    </div>
  );
}
