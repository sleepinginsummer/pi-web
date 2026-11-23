/** Right-panel tabs that cover the file viewer: a subagent session, dev server preview, or team board. */
export type OverlayTab =
  | { id: string; kind: "agent"; sessionId: string; label: string; side?: boolean }
  | { id: string; kind: "server"; serverId: string; label: string }
  | { id: string; kind: "board"; teamId: string; label: string };

export function agentOverlayTabId(sessionId: string): string {
  return `agent:${sessionId}`;
}

export function serverOverlayTabId(serverId: string): string {
  return `server:${serverId}`;
}

export function boardOverlayTabId(teamId: string): string {
  return `board:${teamId}`;
}
