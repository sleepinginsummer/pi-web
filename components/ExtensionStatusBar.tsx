"use client";

import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { ExtensionWidgetShelf } from "./ExtensionWidgetShelf";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  const statusLine = [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");

  // CLI 扩展可能以前导点分隔前一个状态；Web 状态行没有前项时应去掉它。
  return statusLine.replace(/^·\s*/, "");
}

export function ExtensionStatusBar({ statuses, widgets = [] }: { statuses: ExtensionStatusItem[]; widgets?: ExtensionWidgetItem[] }) {
  if (statuses.length === 0 && widgets.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  return (
    <div
      className={`extension-status-bar${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-statuses" : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        minWidth: 0,
        height: 36,
        padding: "0 12px",
        borderTop: "1px solid var(--border)",
        background: "transparent",
      }}
    >
      {widgets.length > 0 && <ExtensionWidgetShelf widgets={widgets} />}
      {statuses.length > 0 && <span
        className="extension-status-line"
        role="status"
        aria-label={plainStatusLine}
        title={plainStatusLine}
        style={{
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        {parseAnsiLine(statusLine).map((segment, index) => (
          <span key={index} style={segment.style}>{segment.text}</span>
        ))}
      </span>}
    </div>
  );
}
