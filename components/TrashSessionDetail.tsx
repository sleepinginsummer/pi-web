"use client";
// 回收站会话详情弹窗：只读展示已删除会话的完整对话内容，支持直接恢复。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import { MessageView } from "./MessageView";
import type { AgentMessage, SessionContext, ToolResultMessage } from "@/lib/types";
import type { TrashedSession } from "@/lib/trash";

interface Props {
  session: TrashedSession;
  onClose: () => void;
  /** 恢复成功后回调（侧边栏刷新 + 面板移除该项） */
  onRestored: () => void;
}

export function TrashSessionDetail({ session, onClose, onRestored }: Props) {
  const { t, locale } = useI18n();
  const [context, setContext] = useState<SessionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  // 加载会话内容（完整加载，不含 defer 标记，详情弹窗无流式补载通道）
  useEffect(() => {
    let cancelled = false;
    setContext(null);
    setError(null);
    fetch(`/api/trash/${encodeURIComponent(session.fileName)}/content`)
      .then(async (r) => {
        const data = await r.json() as { context?: SessionContext; error?: string };
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        if (!cancelled) setContext(data.context ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [session.fileName]);

  // Esc 关闭（TrashPanel 的 Esc 处理已排除详情打开状态，避免同时关闭两层）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // 与 ChatWindow 一致：toolResult 挂到对应 toolCall 下渲染，最后一条 assistant 消息显示时间戳
  const { messages, toolResults, assistantTimestampIndices } = useMemo(() => {
    const msgs = context?.messages ?? [];
    const results = new Map<string, ToolResultMessage>();
    const timestamps = new Set<number>();
    let lastAssistantIndex = -1;
    msgs.forEach((m, idx) => {
      if (m.role === "toolResult") {
        results.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
      }
      if (m.role === "user") {
        if (lastAssistantIndex >= 0) timestamps.add(lastAssistantIndex);
        lastAssistantIndex = -1;
      } else if (m.role === "assistant") {
        lastAssistantIndex = idx;
      }
    });
    if (lastAssistantIndex >= 0) timestamps.add(lastAssistantIndex);
    return { messages: msgs, toolResults: results, assistantTimestampIndices: timestamps };
  }, [context]);

  const handleRestore = async () => {
    setRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/trash/${encodeURIComponent(session.fileName)}`, { method: "POST" });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onRestored();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

  if (!portalTarget) return null;
  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget && !restoring) onClose(); }}
    >
      <div style={{
        width: 860, maxWidth: "100%", height: "min(82vh, 760px)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={session.title}>
              {t("trash.detail")} — {session.title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={session.cwd}>
              {session.cwd} · {t("trash.updatedAt", { time: formatRelativeTime(new Date(session.modified), locale) })}
            </div>
          </div>
          <button onClick={() => void handleRestore()} disabled={restoring} style={{
            display: "flex", alignItems: "center", gap: 4, height: 28, padding: "0 12px", flexShrink: 0,
            background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
            color: "var(--accent)", cursor: restoring ? "default" : "pointer", fontSize: 12, fontWeight: 600, opacity: restoring ? 0.6 : 1,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            {t("trash.restore")}
          </button>
          <button onClick={onClose} disabled={restoring} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px", flexShrink: 0 }}>×</button>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: "6px 16px", fontSize: 12, color: "#ef4444", background: "rgba(239,68,68,0.08)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {error}
          </div>
        )}

        {/* Body: messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
          {context === null && !error ? (
            <div style={{ padding: "24px 18px", color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.loading")}</div>
          ) : messages.length === 0 ? (
            <div style={{ padding: "24px 18px", color: "var(--text-dim)", fontSize: 12 }}>{t("trash.detailEmpty")}</div>
          ) : (
            messages.map((m, idx) => (
              <MessageView
                key={idx}
                message={m}
                toolResults={toolResults}
                cwd={session.cwd}
                showTimestamp={assistantTimestampIndices.has(idx)}
                prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
