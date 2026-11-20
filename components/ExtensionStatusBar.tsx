"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronUp, ListChecks, Puzzle } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { stripAnsi } from "@/lib/ansi";
import { AnsiText } from "./AnsiText";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { ExtensionWidgetShelf } from "./ExtensionWidgetShelf";
import { TODO_WIDGET_KEY } from "@/lib/todo-widget";

/**
 * `ctx.ui.setStatus("command:/mode toggle", "Build")` shows "Build" as a button
 * that sends `/mode toggle`. The command lives in the key because setStatus has
 * no room for it, and Pi's own footer prints only the text, so the same status
 * is still plain text there.
 */
export const EXTENSION_STATUS_COMMAND_PREFIX = "command:";

/** The slash command a status key asks for, or null for an ordinary status. */
export function extensionStatusCommand(key: string): string | null {
  if (!key.startsWith(EXTENSION_STATUS_COMMAND_PREFIX)) return null;
  const command = key.slice(EXTENSION_STATUS_COMMAND_PREFIX.length).trim();
  return command.length > 1 && command.startsWith("/") ? command : null;
}

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function sortedStatuses(statuses: ExtensionStatusItem[]): ExtensionStatusItem[] {
  return [...statuses].sort((a, b) => a.key.localeCompare(b.key));
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  const statusLine = sortedStatuses(statuses)
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");

  // CLI 扩展可能以前导点分隔前一个状态；Web 状态行没有前项时应去掉它。
  return statusLine.replace(/^·\s*/, "");
}

type StatusCell =
  | { kind: "text"; text: string }
  | { kind: "command"; command: string; label: string };

/** One cell per status, in key order. A status with nothing visible to show has no cell. */
export function buildExtensionStatusCells(statuses: ExtensionStatusItem[]): StatusCell[] {
  const cells: StatusCell[] = [];
  for (const item of sortedStatuses(statuses)) {
    const text = sanitizeExtensionStatusText(item.text);
    const command = extensionStatusCommand(item.key);
    if (command) {
      const label = stripAnsi(text).replace(/\s+/g, " ").trim();
      cells.push({ kind: "command", command, label: label || command });
    } else if (stripAnsi(text).trim()) {
      cells.push({ kind: "text", text });
    }
  }
  return cells;
}

function MobileExtensionStatus({ widgets, statuses }: { widgets: ExtensionWidgetItem[]; statuses: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div ref={root} className="mobile-extension-status" onKeyDown={(event) => {
      if (!open || event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector("button")?.focus();
    }}>
      <button type="button" className="extension-widget-trigger" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <span className="extension-widget-icon" aria-hidden="true"><Puzzle size={12} /></span>
        {t("chat.extensionStatus")}
        <ChevronUp size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="extension-widget-panels">
          <section id={id} className="extension-widget-panel mobile-extension-panel" aria-label={t("chat.extensionStatus")}>
            {statuses}
            {widgets.map((widget) => (
              <div key={widget.key}>
                <div className="extension-widget-panel-heading">{widget.key}</div>
                <pre className="extension-widget-content"><AnsiText text={widget.lines.join("\n")} /></pre>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onCommand,
  commandsDisabled = false,
  leading,
  isMobile = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Sends the command of a `command:` status; without it those buttons stay disabled. */
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
  /**
   * Pi Web's own entries before the extension widgets. It may render nothing,
   * which an element cannot tell from outside, so a bar holding only it hides
   * itself with CSS (:has) instead of returning null.
   */
  leading?: ReactNode;
  isMobile?: boolean;
}) {
  const cells = buildExtensionStatusCells(statuses);
  if (cells.length === 0 && widgets.length === 0 && !leading) return null;

  const todo = widgets.find((widget) => widget.key === TODO_WIDGET_KEY);
  const otherWidgets = todo ? widgets.filter((widget) => widget !== todo) : widgets;
  const hasCommands = cells.some((cell) => cell.kind === "command");
  const plainStatusLine = cells
    .map((cell) => (cell.kind === "text" ? stripAnsi(cell.text) : cell.label))
    .join(" ");

  const statusLine = cells.length > 0 ? (
    <div
      role="status"
      className="extension-status-line"
      aria-label={plainStatusLine}
      title={plainStatusLine}
    >
      <span className="extension-status-text">
        {cells.map((cell, index) => cell.kind === "text" ? (
          <span key={index} className="extension-status-item">
            <AnsiText text={cell.text} />
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="extension-status-item extension-status-command"
            disabled={!onCommand || commandsDisabled}
            title={`${cell.label} · ${cell.command}`}
            aria-label={`${cell.label} (${cell.command})`}
            onClick={() => onCommand?.(cell.command)}
          >
            {cell.label}
          </button>
        ))}
      </span>
    </div>
  ) : null;

  return (
    <div
      className={`extension-status-bar${widgets.length > 0 ? " has-widgets" : ""}${cells.length === 0 && widgets.length === 0 ? " has-only-leading" : ""}${cells.length > 0 ? " has-statuses" : ""}${hasCommands ? " has-commands" : ""}`}
      style={{ display: "flex", alignItems: "center", flexShrink: 0, minWidth: 0, ...(isMobile ? {} : { height: 36, padding: "0 10px" }), borderTop: "1px solid var(--border)", background: "transparent" }}
    >
      {leading}
      {todo && (
        <ExtensionWidgetShelf
          widgets={[todo]}
          left
          compactLabel={isMobile ? "chat.todos" : undefined}
          icon={<ListChecks size={12} />}
        />
      )}
      {isMobile ? (
        (otherWidgets.length > 0 || statusLine) && <MobileExtensionStatus widgets={otherWidgets} statuses={statusLine} />
      ) : (
        <>
          {otherWidgets.length > 0 && <ExtensionWidgetShelf widgets={otherWidgets} />}
          {statusLine}
        </>
      )}
    </div>
  );
}
