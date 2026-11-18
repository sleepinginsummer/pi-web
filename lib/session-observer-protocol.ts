import type { SelectedModel } from "./model-types";
import type { ThinkingLevel } from "./thinking-levels";
export const SESSION_OBSERVER_ENTRY = "pi-web:session-observer";
export const OBSERVER_FEEDBACK_LIMIT = 1000;

export type ObserverFeedback = { kind: "known" | "dismiss" | "reply" | "expired"; text?: string };
export type ObserverNote = {
  id: string;
  anchorId: string;
  title: string;
  detail: string;
};

export type ObserverModelPreferences = {
  model: SelectedModel | null;
  thinkingLevel: ThinkingLevel | null;
};

export type ObserverSettings = ObserverModelPreferences & { enabled: boolean };

const DEFAULT_PREFERENCES: ObserverModelPreferences = { model: null, thinkingLevel: null };
export type ObserverRecord =
  | { kind: "enabled"; enabled: boolean }
  | { kind: "preferences"; preferences: ObserverModelPreferences }
  | { kind: "settings"; enabled?: boolean; preferences: ObserverModelPreferences }
  | { kind: "note"; note: ObserverNote }
  | { kind: "feedback"; noteId: string; feedback: ObserverFeedback };

type ObserverEntry = { type: string; customType?: string; data?: unknown };

export type ObserverCard = ObserverNote & { feedback: ObserverFeedback[] };
export type SessionObserverState = {
  enabled: boolean;
  preferences: ObserverModelPreferences;
  checking: boolean;
  cards: ObserverCard[];
};

export function observerRecord(entry: ObserverEntry, sessionId: string): ObserverRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== SESSION_OBSERVER_ENTRY) return;
  const data = entry.data as ({ sessionId?: string; version?: number } & ObserverRecord) | undefined;
  if (data?.sessionId !== sessionId || data.version !== 1) return;
  return data;
}

/** 设置只在开关确实变动时记录 enabled，模型编辑不会重置计步。 */
export function observerEnabledChange(record: ObserverRecord | undefined): boolean | undefined {
  return record?.kind === "enabled" || record?.kind === "settings" ? record.enabled : undefined;
}
export function readObserverEnabled(entries: readonly ObserverEntry[], sessionId: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const data = observerRecord(entries[i], sessionId);
    const enabled = observerEnabledChange(data);
    if (enabled !== undefined) return enabled;
  }
  return false;
}

export function readObserverState(
  sessionId: string,
  entries: readonly ObserverEntry[],
  branch: readonly ObserverEntry[],
  checking = false,
): SessionObserverState {
  const cards = new Map<string, ObserverCard>();
  for (const entry of branch) {
    const data = observerRecord(entry, sessionId);
    if (data?.kind === "note") cards.set(data.note.id, { ...data.note, feedback: [] });
    if (data?.kind === "feedback") cards.get(data.noteId)?.feedback.push(data.feedback);
  }
  const preferenceEntry = entries.findLast((entry) => {
    const record = observerRecord(entry, sessionId);
    return record?.kind === "preferences" || record?.kind === "settings";
  });
  const saved = preferenceEntry && observerRecord(preferenceEntry, sessionId);
  return {
    enabled: readObserverEnabled(entries, sessionId),
    preferences: saved?.kind === "preferences" || saved?.kind === "settings" ? saved.preferences : DEFAULT_PREFERENCES,
    checking,
    cards: Array.from(cards.values()),
  };
}
