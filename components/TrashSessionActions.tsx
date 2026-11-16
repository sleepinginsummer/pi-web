"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { TrashedSession } from "@/lib/trash";
import { useI18n } from "@/hooks/useI18n";

export const trashButtonStyle: CSSProperties = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
  color: "var(--text-muted)", cursor: "pointer", padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap",
};

/** 列表与详情共用 AI 重命名操作，生成成功后同时更新两处标题。 */
export function TrashSessionActions({ session, onRenamed, disabled = false }: {
  session: TrashedSession;
  onRenamed: (session: TrashedSession) => void;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const [showInfo, setShowInfo] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!showInfo) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setShowInfo(false);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [showInfo]);
  const zh = locale.startsWith("zh");
  const formatTime = (time: number | null) => time === null ? (zh ? "未知" : "Unknown") : new Date(time).toLocaleString(locale);
  const rows = [
    [zh ? "源文件位置" : "Original file", session.originalPath],
    [zh ? "回收站位置" : "Trash file", session.trashPath],
    [zh ? "删除时间" : "Deleted", formatTime(session.deleted)],
    [zh ? "创建时间" : "Created", formatTime(session.created)],
    [zh ? "最后更新时间" : "Last updated", formatTime(session.modified)],
  ];
  const rename = async () => {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/trash/${encodeURIComponent(session.fileName)}/rename`, { method: "POST" });
      const data = await response.json() as { session?: TrashedSession; error?: string };
      if (!response.ok || !data.session) throw new Error(data.error ?? `HTTP ${response.status}`);
      onRenamed(data.session);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };
  return <div onClick={(event) => event.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <div style={{ display: "flex", gap: 6 }}>
      <button type="button" style={trashButtonStyle} disabled={disabled} onClick={() => setShowInfo(true)}>{zh ? "信息" : "Info"}</button>
      <button type="button" style={trashButtonStyle} disabled={disabled || generating} aria-busy={generating}
        title={zh ? "使用 AI 重新生成标题" : "Regenerate title with AI"} onClick={() => void rename()}>
        {generating ? (zh ? "生成中…" : "Generating…") : (zh ? "重命名" : "Rename")}
      </button>
    </div>
    {error && <div role="alert" style={{ color: "#ef4444", fontSize: 12, maxWidth: 280, overflowWrap: "anywhere", whiteSpace: "normal" }}>{error}</div>}
    {showInfo && <div onClick={() => setShowInfo(false)}
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={zh ? "会话信息" : "Session info"}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 560, maxWidth: "100%", maxHeight: "85dvh", overflowY: "auto", padding: 20, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <strong>{zh ? "会话信息" : "Session info"}</strong>
          <button type="button" aria-label={zh ? "关闭" : "Close"} style={trashButtonStyle} onClick={() => setShowInfo(false)}>×</button>
        </div>
        <dl style={{ margin: 0, fontSize: 13 }}>{rows.map(([label, value]) => <div key={label} style={{ marginTop: 12 }}>
          <dt style={{ color: "var(--text-dim)", marginBottom: 4 }}>{label}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere", userSelect: "text" }}>{value}</dd>
        </div>)}</dl>
      </div>
    </div>}
  </div>;
}
