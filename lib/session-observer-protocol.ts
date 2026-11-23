import type { SelectedModel } from "./model-types";
import { applyObserverEdit, type ObserverEdit, type ObserverItem } from "./observer-checklist";
import type { ThinkingLevel } from "./thinking-levels";

/**
 * 会话观察员全局功能开关。
 * 观察员交互记录在长会话中会膨胀到上百 MB，暂时全局关闭（前端隐藏入口、后端停跑并停注册扩展）；
 * 保留协议与实现代码，改回 true 即可恢复。
 */
export const SESSION_OBSERVER_FEATURE_ENABLED = false;
export const SESSION_OBSERVER_ENTRY = "pi-web:session-observer";
export const DEFAULT_OBSERVER_INTERVAL = 10;
export const OBSERVER_FOCUS_PRESETS = ["balanced", "risks", "requirements"] as const;
export type ObserverFocusPreset = typeof OBSERVER_FOCUS_PRESETS[number];
export const OBSERVER_FOCUS_NOTE_LIMIT = 300;

export function isObserverInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isObserverFocusPreset(value: unknown): value is ObserverFocusPreset {
  return typeof value === "string" && (OBSERVER_FOCUS_PRESETS as readonly string[]).includes(value);
}

export function normalizeObserverFocusNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Invalid observer focus note");
  const trimmed = value.trim();
  if (trimmed.length > OBSERVER_FOCUS_NOTE_LIMIT) throw new Error("Invalid observer focus note");
  return trimmed || undefined;
}

export type ObserverModelPreferences = {
  model: SelectedModel | null;
  thinkingLevel: ThinkingLevel | null;
  interval?: number;
  focus?: ObserverFocusPreset;
  focusNote?: string;
};
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
  | { kind: "summary"; summary: ObserverSummary }
  | { kind: "interaction"; interaction: StoredObserverInteraction };

type ObserverContextUsage = { tokens: number; contextWindow: number };
export type ObserverInteraction = {
  phase: "summary" | "check";
  startedAt: number;
  model: SelectedModel;
  thinkingLevel: ThinkingLevel;
  prompt: string;
  input: string | null;
  output: { type: "text" | "thinking" | "toolCall"; text: string }[];
  toolResults?: { name: string; id: string; isError: boolean; text: string }[];
  contextUsage?: ObserverContextUsage;
  status: string;
  failure?: "outputLimit" | "timeout" | "provider" | "toolCall";
  costUsd: number | null;
};

export type StoredObserverInteraction = Omit<ObserverInteraction, "input"> & (
  | { input: string; inputRef?: never }
  | { input?: never; inputRef: string }
);
export type ObserverHistoryPage = {
  interactions: (ObserverInteraction & { id: string })[];
  nextBefore: string | null;
};

type ObserverEntry = { type: string; customType?: string; data?: unknown; timestamp?: string };
export type SessionObserverState = {
  enabled: boolean;
  preferences: ObserverModelPreferences;
  checking: boolean;
  items: ObserverItem[];
  costUsd: number | null;
  contextUsage?: ObserverContextUsage;
};

export function observerRecord(entry: ObserverEntry, sessionId: string): ObserverRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== SESSION_OBSERVER_ENTRY) return;
  const data = entry.data as ({ sessionId?: string; version?: number } & ObserverRecord) | undefined;
  if (data?.sessionId !== sessionId || data.version !== 1) return;
  return data;
}

export function readObserverHistory(sessionId: string, entries: readonly (ObserverEntry & { id: string })[], before?: string): ObserverHistoryPage {
  const end = before === undefined ? entries.length : entries.findIndex(({ id }) => id === before);
  const interactions: ObserverHistoryPage["interactions"] = [];
  let entryPositions: Map<string, number> | undefined;
  for (let i = end - 1; i >= 0; i--) {
    const entry = entries[i];
    const record = observerRecord(entry, sessionId);
    if (record?.kind !== "interaction") continue;
    if (interactions.length === 10) return { interactions, nextBefore: interactions.at(-1)?.id ?? null };
    const { input, inputRef, ...interaction } = record.interaction;
    let evidence = input ?? null;
    if (inputRef !== undefined) {
      // 引用可以跨页，但只指向同一会话中更早、保存了原文的交互。
      entryPositions ??= new Map(entries.map(({ id }, index) => [id, index]));
      const position = entryPositions.get(inputRef);
      const source = position !== undefined && position < i ? observerRecord(entries[position], sessionId) : undefined;
      if (source?.kind === "interaction") evidence = source.interaction.input ?? null;
    }
    interactions.push({ ...interaction, input: evidence, id: entry.id });
  }
  return { interactions, nextBefore: null };
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
  let contextUsage: ObserverContextUsage | undefined;
  for (const entry of branch) {
    const record = observerRecord(entry, sessionId);
    if (record?.kind === "interaction" && record.interaction.contextUsage) contextUsage = record.interaction.contextUsage;
    // 用新增记录的时间，兼容旧事项并让编辑和重排保留原时间。
    if (record?.kind === "checklist" || record?.kind === "checked") {
      for (const edit of record.edits) {
        items = applyObserverEdit(items, edit.action === "add" && entry.timestamp
          ? { ...edit, item: { ...edit.item, createdAt: entry.timestamp } }
          : edit);
      }
    }
    // 旧提醒直接显示为清单项，已了解的提醒恢复为已完成。
    if (record?.kind === "note") items.push({ id: record.note.id, title: record.note.title, done: false, priority: "normal", ...(entry.timestamp && { createdAt: entry.timestamp }) });
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
  let costUsd: number | null = null;
  for (const entry of entries) {
    const record = observerRecord(entry, sessionId);
    const cost = record?.kind === "interaction" ? record.interaction.costUsd : null;
    if (cost != null && Number.isFinite(cost) && cost >= 0) costUsd = (costUsd ?? 0) + cost;
  }
  return {
    enabled: readObserverEnabled(entries, sessionId),
    preferences: saved?.kind === "preferences" || saved?.kind === "settings" ? saved.preferences : { model: null, thinkingLevel: null },
    checking,
    items,
    costUsd,
    ...(contextUsage && { contextUsage }),
  };
}
