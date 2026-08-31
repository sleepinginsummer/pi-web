"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ExtensionWidgetItem } from "@/lib/types";

const DEFAULT_EXPANDED_LINE_LIMIT = 3;
const UPDATE_PULSE_MS = 1100;

function snapshotWidgets(widgets: ExtensionWidgetItem[]): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

function getChangedWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return [...next].flatMap(([key, lines]) => {
    const oldLines = previous.get(key);
    if (!oldLines || oldLines.length !== lines.length) return oldLines ? [key] : [];
    return lines.some((line, index) => line !== oldLines[index]) ? [key] : [];
  });
}

function getInitialExpandedKey(widgets: ExtensionWidgetItem[]): string | null {
  return widgets.find((widget) => (
    widget.lines.length > 1 && widget.lines.length <= DEFAULT_EXPANDED_LINE_LIMIT
  ))?.key ?? null;
}

export function ExtensionWidgetShelf({ widgets }: { widgets: ExtensionWidgetItem[] }) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousWidgetsRef = useRef<Map<string, string[]> | null>(null);
  const pulseTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [expandedKey, setExpandedKey] = useState<string | null>(() => getInitialExpandedKey(widgets));
  const [updatingKeys, setUpdatingKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const next = snapshotWidgets(widgets);
    const changed = getChangedWidgetKeys(previousWidgetsRef.current, next);
    previousWidgetsRef.current = next;

    setUpdatingKeys((current) => {
      const retained = new Set([...current].filter((key) => next.has(key)));
      changed.forEach((key) => retained.add(key));
      return retained.size === current.size && [...retained].every((key) => current.has(key))
        ? current
        : retained;
    });

    for (const [key, timer] of pulseTimersRef.current) {
      if (!next.has(key)) {
        clearTimeout(timer);
        pulseTimersRef.current.delete(key);
      }
    }
    for (const key of changed) {
      const oldTimer = pulseTimersRef.current.get(key);
      if (oldTimer) clearTimeout(oldTimer);
      pulseTimersRef.current.set(key, setTimeout(() => {
        pulseTimersRef.current.delete(key);
        setUpdatingKeys((current) => {
          if (!current.has(key)) return current;
          const nextKeys = new Set(current);
          nextKeys.delete(key);
          return nextKeys;
        });
      }, UPDATE_PULSE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of pulseTimersRef.current.values()) clearTimeout(timer);
    pulseTimersRef.current.clear();
  }, []);

  if (widgets.length === 0) return null;

  const expanded = widgets.find((widget) => widget.key === expandedKey && widget.lines.length > 1);
  const expandedIndex = expanded ? widgets.findIndex((widget) => widget.key === expanded.key) : -1;
  const expandedPanelId = expandedIndex >= 0 ? `${idPrefix}-panel-${expandedIndex}` : undefined;
  const toggle = (key: string) => setExpandedKey((current) => current === key ? null : key);

  return (
    <>
      {expanded && (
        <div className="extension-widget-panels">
          <section
            id={expandedPanelId}
            className="extension-widget-panel"
            aria-label={expanded.key}
            aria-live="polite"
          >
            <div className="extension-widget-panel-heading">{expanded.key}</div>
            <pre className="extension-widget-content">{expanded.lines.join("\n")}</pre>
          </section>
        </div>
      )}
      <div className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
        {widgets.map((widget, index) => {
          const expandable = widget.lines.length > 1;
          const isExpanded = expandable && expanded?.key === widget.key;
          const triggerId = `${idPrefix}-trigger-${index}`;
          const panelId = `${idPrefix}-panel-${index}`;
          const placement = widget.placement === "belowEditor"
            ? t("chat.extensionWidgetBelow")
            : t("chat.extensionWidgetAbove");
          const lineLabel = widget.lines.length === 1
            ? t("chat.extensionWidgetLine")
            : t("chat.extensionWidgetLines", { count: widget.lines.length });
          const label = `${widget.key}, ${lineLabel}, ${placement}`;

          return expandable ? (
            <button
              key={widget.key}
              id={triggerId}
              type="button"
              className={`extension-widget-trigger${isExpanded ? " is-expanded" : ""}${updatingKeys.has(widget.key) ? " is-updating" : ""}`}
              aria-expanded={isExpanded}
              aria-controls={panelId}
              aria-label={label}
              title={label}
              onClick={() => toggle(widget.key)}
            >
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">{widget.placement === "belowEditor" ? "v" : "^"}</span>
              <span className="extension-widget-key">{widget.key}</span>
            </button>
          ) : (
            <div
              key={widget.key}
              className={`extension-widget-trigger${updatingKeys.has(widget.key) ? " is-updating" : ""}`}
              role="status"
              aria-label={label}
              title={label}
            >
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">{widget.placement === "belowEditor" ? "v" : "^"}</span>
              <span className="extension-widget-key">{widget.key}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
