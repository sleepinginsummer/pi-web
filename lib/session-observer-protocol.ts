import type { SelectedModel } from "./model-types";
import { applyObserverEdit, type ObserverEdit, type ObserverItem } from "./observer-checklist";
import type { ThinkingLevel } from "./thinking-levels";

export const SESSION_OBSERVER_ENTRY = "pi-web:session-observer";
export const DEFAULT_OBSERVER_INTERVAL = 6;

export function isObserverInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export type ObserverModelPreferences = { model: SelectedModel | null; thinkingLevel: ThinkingLevel | null; interval?: number };
export type ObserverSettings = ObserverModelPreferences & { enabled: boolean };
export type ObserverSummary = { throughId: string; text: string };

export type ObserverRecord =
  | { kind: "enabled"; enabled: boolean }
  | { kind: "preferences"; preferences: ObserverModelPreferences }
  | { kind: "settings"; enabled?: boolean; preferences: ObserverModelPreferences }
  | { kind: "note"; note: { id: string; title: string } }
  | { kind: "feedback"; noteId: string; feedback: { kind: string } }
  | { kind: "checklist"; edits: ObserverEdit[] }
  | { kind: "checked"; throughId: string; edits: ObserverEdit[] }
  | { kind: "summary"; summary: ObserverSummary };

type ObserverEntry = { type: string; customType?: string; data?: unknown };
export type SessionObserverState = {
  enabled: boolean;
  preferences: ObserverModelPreferences;
  checking: boolean;
  items: ObserverItem[];
};

export function observerRecord(entry: ObserverEntry, sessionId: string): ObserverRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== SESSION_OBSERVER_ENTRY) return;
  const data = entry.data as ({ sessionId?: string; version?: number } & ObserverRecord) | undefined;
  if (data?.sessionId !== sessionId || data.version !== 1) return;
  return data;
}

export function observerEnabledChange(record: ObserverRecord | undefined): boolean | undefined {
  return record?.kind === "enabled" || record?.kind === "settings" ? record.enabled : undefined;
}

export function readObserverEnabled(entries: readonly ObserverEntry[], sessionId: string): boolean {
  const change = entries.findLast((entry) => observerEnabledChange(observerRecord(entry, sessionId)) !== undefined);
  return change ? observerEnabledChange(observerRecord(change, sessionId)) === true : false;
}

export function readObserverState(
  sessionId: string,
  entries: readonly ObserverEntry[],
  branch: readonly ObserverEntry[],
  checking = false,
): SessionObserverState {
  let items: ObserverItem[] = [];
  for (const entry of branch) {
    const record = observerRecord(entry, sessionId);
    if (record?.kind === "checklist" || record?.kind === "checked") items = record.edits.reduce(applyObserverEdit, items);
    // 旧提醒直接显示为清单项，已了解的提醒恢复为已完成。
    if (record?.kind === "note") items.push({ id: record.note.id, title: record.note.title, done: false, priority: "normal" });
    if (record?.kind === "feedback" && record.feedback.kind === "known") {
      const item = items.find(({ id }) => id === record.noteId);
      if (item) items = applyObserverEdit(items, { action: "update", id: item.id, patch: { done: true } });
    }
  }
  const preferenceEntry = entries.findLast((entry) => {
    const record = observerRecord(entry, sessionId);
    return record?.kind === "preferences" || record?.kind === "settings";
  });
  const saved = preferenceEntry && observerRecord(preferenceEntry, sessionId);
  return {
    enabled: readObserverEnabled(entries, sessionId),
    preferences: saved?.kind === "preferences" || saved?.kind === "settings" ? saved.preferences : { model: null, thinkingLevel: null },
    checking,
    items,
  };
}
