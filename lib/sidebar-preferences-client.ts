import {
  emptySidebarPreferences,
  rebaseSidebarPreferenceAction,
  uniquePreferenceIds,
  type SidebarPreferenceAction,
  type SidebarPreferences,
} from "./sidebar-preference-state";

const SESSION_ORDER_STORAGE_KEY = "pi-web:session-order";
const PINNED_SESSIONS_STORAGE_KEY = "pi-web:pinned-session-ids";

function readLocalArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    return uniquePreferenceIds(JSON.parse(window.localStorage.getItem(key) ?? "[]"));
  } catch {
    return [];
  }
}

export function initialSidebarPreferences(): SidebarPreferences {
  return {
    ...emptySidebarPreferences(),
    sessionOrder: readLocalArray(SESSION_ORDER_STORAGE_KEY),
    pinnedSessionIds: readLocalArray(PINNED_SESSIONS_STORAGE_KEY),
  };
}

export function readLegacySidebarPreferences(): Pick<SidebarPreferences, "sessionOrder" | "pinnedSessionIds"> {
  return {
    sessionOrder: readLocalArray(SESSION_ORDER_STORAGE_KEY),
    pinnedSessionIds: readLocalArray(PINNED_SESSIONS_STORAGE_KEY),
  };
}

export function clearLegacySidebarPreferences(): void {
  window.localStorage.removeItem(SESSION_ORDER_STORAGE_KEY);
  window.localStorage.removeItem(PINNED_SESSIONS_STORAGE_KEY);
}

export async function fetchSidebarPreferences(): Promise<SidebarPreferences> {
  const response = await fetch("/api/sidebar-preferences", { cache: "no-store" });
  const data = await response.json() as { preferences?: SidebarPreferences; error?: string };
  if (!response.ok || !data.preferences) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.preferences;
}

export async function patchSidebarPreferences(
  expectedRevision: number,
  action: SidebarPreferenceAction,
): Promise<{ preferences: SidebarPreferences; conflict: boolean }> {
  const response = await fetch("/api/sidebar-preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision, action }),
  });
  const data = await response.json() as { preferences?: SidebarPreferences; error?: string };
  if (response.status === 409 && data.preferences) return { preferences: data.preferences, conflict: true };
  if (!response.ok || !data.preferences) throw new Error(data.error ?? `HTTP ${response.status}`);
  return { preferences: data.preferences, conflict: false };
}

/** revision 冲突时基于服务端最新快照重放一次用户动作。 */
export async function patchSidebarPreferencesWithRetry(
  expectedRevision: number,
  action: SidebarPreferenceAction,
): Promise<{ preferences: SidebarPreferences; conflict: boolean }> {
  const first = await patchSidebarPreferences(expectedRevision, action);
  if (!first.conflict) return first;
  return patchSidebarPreferences(
    first.preferences.revision,
    rebaseSidebarPreferenceAction(first.preferences, action),
  );
}
