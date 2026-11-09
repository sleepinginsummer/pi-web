export type SystemPromptAddonState = { enabled: boolean; text: string };

async function requestAddon(init?: RequestInit, sessionId?: string | null): Promise<SystemPromptAddonState> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const response = await fetch(`/api/system-prompt-addon${query}`, init);
  const body = await response.json() as SystemPromptAddonState & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function getSystemPromptAddon(sessionId: string | null): Promise<SystemPromptAddonState> {
  return requestAddon(undefined, sessionId);
}

export function putSystemPromptAddon(patch: { text?: string; sessionId?: string; enabled?: boolean }): Promise<SystemPromptAddonState> {
  return requestAddon({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// 尚未创建的会话没有 id，开关先按 cwd 记在页面内，与 ChatWindow 的重新挂载无关。
const stagedCwds = new Set<string>();

export function isSystemPromptAddonStaged(cwd: string): boolean {
  return stagedCwds.has(cwd);
}

export function setSystemPromptAddonStaged(cwd: string, enabled: boolean): void {
  if (enabled) stagedCwds.add(cwd);
  else stagedCwds.delete(cwd);
}

/** 必须在首条消息发出之前完成，否则第一轮拿不到补充提示词。失败时保留预设，重试可再次写入。 */
export async function commitStagedSystemPromptAddon(cwd: string, sessionId: string): Promise<void> {
  if (!stagedCwds.has(cwd)) return;
  await putSystemPromptAddon({ sessionId, enabled: true });
  stagedCwds.delete(cwd);
}
