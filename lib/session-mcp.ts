import type { McpMenuServerStatus } from "./mcp-host";

/** 当前会话的 MCP 展示信息，不携带配置、凭据或传输日志。 */
export type SessionMcpServer = McpMenuServerStatus;

export interface SessionMcpSnapshot {
  sessionId: string;
  live: boolean;
  servers: SessionMcpServer[];
}

/** 只读存活实例，不为查看菜单重启会话或连接 MCP。旧 HMR 实例没有读取方法时返回空列表。 */
export function readSessionMcpSnapshot(sessionId: string, session: {
  isAlive(): boolean;
  getMcpServerStates?: () => McpMenuServerStatus[];
} | undefined): SessionMcpSnapshot {
  const live = session?.isAlive() === true;
  const servers = live ? session?.getMcpServerStates?.() ?? [] : [];
  return {
    sessionId,
    live,
    servers: servers.map(({ name, scope, state }) => ({ name, scope, state })),
  };
}
