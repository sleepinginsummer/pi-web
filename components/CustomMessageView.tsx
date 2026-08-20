"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type { CustomMessage, ImageContent } from "@/lib/types";
import { MarkdownBody } from "./MarkdownBody";
import { formatMessageTime, getMessageImages, getMessageText, MessageImage } from "./MessageContentPrimitives";

interface Props {
  message: CustomMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

/** 渲染扩展自定义消息，并在该边界内适配扩展专属展示协议。 */
export function CustomMessageView({ message, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const rawText = getMessageText(message.content);
  const shadowEvent = message.customType === "shadow-mind" ? readShadowMindEvent(message.details) : null;
  const text = shadowEvent ? formatShadowMindEvent(shadowEvent, t) : rawText;
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const contentView: CustomMessageContentView = contentExpanded
    ? { mode: "expanded", text, images, cwd, onOpenFile }
    : { mode: "collapsed", preview: text ? previewText(text) : null, onExpand: () => setContentExpanded(true) };
  const toggle = isHiddenDisplay
    ? { mode: "content" as const, expanded: contentExpanded, onToggle: () => setContentExpanded((value) => !value) }
    : hasDetails
      ? { mode: "details" as const, expanded: detailsExpanded, onToggle: () => setDetailsExpanded((value) => !value) }
      : null;
  const actionsView: CustomMessageActionsView = {
    copy: text || detailsText
      ? {
          copied,
          onCopy: () => {
            copyText(text || detailsText).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          },
        }
      : null,
    toggle,
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
        opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
      }}>
        <CustomMessageHeader
          title={message.customType || "extension"}
          time={formatMessageTime(message.timestamp)}
          hidden={isHiddenDisplay}
        />
        <CustomMessageContent view={contentView} />
        <CustomMessageActions view={actionsView} />
        <CustomMessageDetails
          visible={hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded))}
          text={detailsText}
        />
      </div>
    </div>
  );
}

function CustomMessageHeader({ title, time, hidden }: { title: string; time: string | null; hidden: boolean }) {
  const { t } = useI18n();
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 10px",
      borderBottom: "1px solid var(--border)",
      background: "var(--bg-panel)",
      color: "var(--text-muted)",
      fontSize: 12,
    }}>
      <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
        {title}
      </span>
      {hidden && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.hiddenExtensionMessage")}</span>}
      {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
    </div>
  );
}

type CustomMessageContentView =
  | { mode: "collapsed"; preview: string | null; onExpand: () => void }
  | { mode: "expanded"; text: string; images: ImageContent[]; cwd?: string; onOpenFile?: (filePath: string) => void };

function CustomMessageContent({ view }: { view: CustomMessageContentView }) {
  const { t } = useI18n();
  if (view.mode === "collapsed") {
    return (
      <button onClick={view.onExpand} style={{
        display: "block",
        width: "100%",
        padding: "8px 10px",
        border: "none",
        background: "transparent",
        color: "var(--text-dim)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}>
        {view.preview ?? t("i18n.showExtensionMessage")}
      </button>
    );
  }
  return (
    <div style={{ padding: "6px 9px" }}>
      {view.images.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: view.text ? 8 : 0 }}>
          {view.images.map((image, index) => <MessageImage key={index} image={image} variant="custom" />)}
        </div>
      )}
      {view.text
        ? <MarkdownBody className="markdown-custom-message" cwd={view.cwd} onOpenFile={view.onOpenFile}>{view.text}</MarkdownBody>
        : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
    </div>
  );
}

type CustomMessageActionsView = {
  copy: { copied: boolean; onCopy: () => void } | null;
  toggle: { mode: "content" | "details"; expanded: boolean; onToggle: () => void } | null;
};

function CustomMessageActions({ view }: { view: CustomMessageActionsView }) {
  const { t } = useI18n();
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "4px 9px",
      borderTop: "1px solid var(--border)",
      background: "var(--bg-subtle)",
    }}>
      {view.copy && (
        <button onClick={view.copy.onCopy} style={{
          padding: "3px 7px",
          border: "none",
          background: "none",
          color: view.copy.copied ? "var(--accent)" : "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11,
        }}>
          {view.copy.copied ? t("i18n.copied") : t("i18n.copy")}
        </button>
      )}
      {view.toggle && (
        <button onClick={view.toggle.onToggle} style={{
          marginLeft: "auto",
          padding: "3px 7px",
          border: "none",
          background: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11,
        }}>
          {view.toggle.mode === "content"
            ? (view.toggle.expanded ? t("i18n.collapse") : t("i18n.expand"))
            : (view.toggle.expanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
        </button>
      )}
    </div>
  );
}

function CustomMessageDetails({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null;
  return (
    <pre style={{
      margin: 0,
      padding: "9px 10px",
      borderTop: "1px solid var(--border)",
      background: "var(--bg)",
      color: "var(--text-muted)",
      fontSize: 12,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      maxHeight: 360,
      overflow: "auto",
      fontFamily: "var(--font-mono)",
    }}>
      {text}
    </pre>
  );
}

type ShadowMindEvent =
  | { event: "run-start"; shadowId: string; model: string | null }
  | { event: "run-end"; shadowId: string; reason: string | null; durationMs: number | null }
  | { event: "runs-aborted"; count: number; reason: string | null };

function readShadowMindEvent(details: unknown): ShadowMindEvent | null {
  if (!details || typeof details !== "object") return null;
  const value = details as Record<string, unknown>;
  if (value.event === "run-start" && typeof value.shadowId === "string") {
    return { event: "run-start", shadowId: value.shadowId, model: typeof value.model === "string" ? value.model : null };
  }
  if (value.event === "run-end" && typeof value.shadowId === "string") {
    return { event: "run-end", shadowId: value.shadowId, reason: typeof value.reason === "string" ? value.reason : null, durationMs: typeof value.durationMs === "number" ? value.durationMs : null };
  }
  if (value.event === "runs-aborted" && typeof value.count === "number") {
    return { event: "runs-aborted", count: value.count, reason: typeof value.reason === "string" ? value.reason : null };
  }
  return null;
}

function formatShadowMindEvent(event: ShadowMindEvent, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (event.event === "run-start") {
    return t("chat.shadowMindStarted", { id: event.shadowId, model: event.model ? t("chat.shadowMindModel", { model: event.model }) : "" }).trim();
  }
  if (event.event === "run-end") {
    const detail = event.reason === "silent" ? t("chat.shadowMindSilent") : t("chat.shadowMindFinishedReason", { reason: event.reason ?? "unknown" });
    return t("chat.shadowMindFinished", { id: event.shadowId, detail, duration: event.durationMs ?? 0 }).trim();
  }
  return t("chat.shadowMindAborted", { count: event.count, reason: event.reason ?? "unknown" });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}
