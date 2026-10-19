/** Right-panel tabs that cover the file viewer: a subagent session or a dev server preview. */
export type OverlayTab =
  | { id: string; kind: "agent"; sessionId: string; label: string }
  | { id: string; kind: "server"; serverId: string; label: string };

export function agentOverlayTabId(sessionId: string): string {
  return `agent:${sessionId}`;
}

export function serverOverlayTabId(serverId: string): string {
  return `server:${serverId}`;
}
