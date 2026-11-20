"use client";

import { useState, type ReactNode } from "react";
import { formatTurnDuration } from "@/lib/turn-duration";
import type { CacheMissSummary } from "@/lib/transcript-notices";
import { cacheMissSummaryText, TRANSCRIPT_NOTICE_WARNING_COLOR } from "./TranscriptNotices";

// 主会话与回收站共用过程折叠样式和交互。
export function ProcessDetailsGroup({ messageCount, toolCallCount, durationMs, cacheMisses, defaultExpanded = false, reveal = false, renderRecent, renderChildren, t }: { messageCount: number; toolCallCount: number; durationMs?: number; cacheMisses?: CacheMissSummary; defaultExpanded?: boolean; reveal?: boolean; renderRecent?: () => ReactNode; renderChildren: () => ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentVisible = expanded || reveal;
  // 折叠箭头已表达可展开，「过程详情」文字只保留在无障碍名称中。
  const parts = [`${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  if (durationMs !== undefined) parts.push(t("chat.turnDuration", { time: formatTurnDuration(durationMs) }));
  // Folded, the cache misses inside are added up here (#1265); open, each shows under its step.
  const cacheMissText = cacheMisses && !(expanded || reveal) ? cacheMissSummaryText(t, cacheMisses) : undefined;

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={contentVisible}
        aria-label={[t("chat.processDetails"), ...parts, ...(cacheMissText ? [cacheMissText] : [])].join(" · ")}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          maxWidth: "100%",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
          {cacheMissText && <span style={{ color: TRANSCRIPT_NOTICE_WARNING_COLOR }}>{` · ${cacheMissText}`}</span>}
        </span>
      </button>
      {/* 折叠时也可以先亮出最新几条（当前轮用），点开才是全部。 */}
      {contentVisible ? (
        <div style={{ marginTop: 8 }}>
          {renderChildren()}
        </div>
      ) : renderRecent ? (
        <div style={{ marginTop: 8 }}>
          {renderRecent()}
        </div>
      ) : null}
    </div>
  );
}
