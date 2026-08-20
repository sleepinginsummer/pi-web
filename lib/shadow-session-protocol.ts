export type ShadowStateEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

export const SHADOW_MIND_SESSION_STATE = "pi-web-shadow-mind-state";

export function readShadowMindStateEntry(entry: ShadowStateEntryLike | undefined): boolean | null {
  if (entry?.type !== "custom" || entry.customType !== SHADOW_MIND_SESSION_STATE) return null;
  const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
  return typeof enabled === "boolean" ? enabled : null;
}

export function parseShadowMindToggleCommand(text: string): boolean | null {
  const match = text.trim().match(/^\/shadow\s+(pause|resume)$/i);
  if (!match) return null;
  return match[1].toLowerCase() === "resume";
}

/** 从会话历史恢复最后一次有效开关状态；未配置时默认开启。 */
export function readSessionShadowMindEnabled(entries: readonly ShadowStateEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const enabled = readShadowMindStateEntry(entries[index]);
    if (enabled !== null) return enabled;
  }
  return true;
}
