"use client";

import React, { useId, useState } from "react";
import { Plug } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { usePolledJson } from "@/hooks/usePolledJson";
import type { SessionMcpServer, SessionMcpSnapshot } from "@/lib/session-mcp";

const STATE_KEYS: Record<SessionMcpServer["state"], string> = {
  ready: "mcp.session.state.connected",
  connecting: "mcp.session.state.connecting",
  failed: "mcp.session.state.failed",
  "needs-auth": "mcp.session.state.needs-auth",
  disconnected: "mcp.session.state.disconnected",
  "not-registered": "workspaceHud.mcpNotRegistered",
  "not-trusted": "mcp.session.state.not-trusted",
};

/** 与工作区其它栏目共用折叠样式；组件仅在整卡展开时挂载，隐藏标签页暂停轮询。 */
export function WorkspaceMcpSection({ sessionId }: { sessionId?: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const { data, error, refresh } = usePolledJson<SessionMcpSnapshot>(
    sessionId ? `/api/agent/${encodeURIComponent(sessionId)}?view=mcp` : null,
    4000,
  );
  // 请求切换后的首帧可能仍持有上一份数据，身份不符时不展示。
  const snapshot = data?.sessionId === sessionId ? data : null;
  const servers = snapshot?.servers ?? [];
  const loading = Boolean(sessionId && !snapshot && !error);

  return (
    <div data-workspace-mcp className="workspace-hud-section">
      <button
        type="button"
        className="workspace-hud-sec-header"
        aria-label={`MCP ${loading ? "…" : servers.length}`}
        title="MCP"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="workspace-hud-sec-left">
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <Plug size={14} aria-hidden="true" />
          <span className="workspace-hud-count">{loading ? "…" : servers.length}</span>
        </span>
      </button>
      {open && (
        <div id={id} className="workspace-hud-sec-list">
          {error ? (
            <div className="workspace-hud-row">
              <span className="workspace-hud-row-sub" role="alert" title={error}>{t("workspaceHud.mcpReadFailed")}</span>
              <button type="button" className="workspace-hud-mini-btn" onClick={() => void refresh()}>{t("workspaceHud.mcpRetry")}</button>
            </div>
          ) : loading ? (
            <div className="workspace-hud-row-sub" style={{ padding: "8px" }}>{t("workspaceHud.mcpLoading")}</div>
          ) : servers.length === 0 ? (
            <div className="workspace-hud-row-sub" style={{ padding: "8px", whiteSpace: "normal" }}>
              {t(snapshot && !snapshot.live ? "workspaceHud.mcpInactive" : "workspaceHud.mcpEmpty")}
            </div>
          ) : servers.map((server) => (
            <div key={`${server.scope}:${server.name}`} className="workspace-hud-row" style={{ cursor: "default" }}>
              <span className="workspace-hud-row-main">
                <span className="workspace-hud-row-title" title={server.name}>{server.name}</span>
              </span>
              <span className="workspace-hud-row-sub">{t(STATE_KEYS[server.state])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
