import { stripVTControlCharacters } from "node:util";
import type { McpCommandCandidate } from "./mcp-command";
import type { McpMenuServerStatus } from "./mcp-host";

/** 当前会话的 MCP 展示信息，不携带配置、凭据或传输日志。 */
export type SessionMcpServer = McpMenuServerStatus;

export interface SessionMcpCounts {
  connected: number;
  total: number;
}

export interface SessionMcpSnapshot {
  sessionId: string;
  live: boolean;
  /** null 表示实际管理方未提供可读计数，不能把未知状态报成 0/0。 */
  counts: SessionMcpCounts | null;
  servers: SessionMcpServer[];
}

/**
 * pi-mcp-adapter 7 的延迟初始化仅发布状态栏，不发布结构化状态事件。
 * 只认该适配器当前会话的两种正式状态栏格式，不读配置或调用 MCP 来获取计数。
 * undefined 表示不是该适配器；null 表示状态栏关闭或格式未知。
 */
export function readMcpAdapterCounts(commands: readonly McpCommandCandidate[], status: string | undefined): SessionMcpCounts | null | undefined {
  const ownsMcp = commands.some((command) => command.name === "mcp"
    && /(?:^|\/)pi-mcp-adapter\/index\.(?:[cm]?js|ts)$/.test(command.sourceInfo?.path?.replaceAll("\\", "/") ?? ""));
  if (!ownsMcp) return undefined;
  const text = stripVTControlCharacters(status ?? "").trim();
  const compact = /^MCP (\d+)\/(\d+)$/.exec(text);
  const full = /^(?:🔌 )?MCP: (\d+) servers? enabled(?: \((\d+) connected\))?(?: \(\d+ disabled\))?$/.exec(text);
  if (!compact && !full) return null;
  const connected = Number(compact ? compact[1] : full![2] ?? 0);
  const total = Number(compact ? compact[2] : full![1]);
  return Number.isSafeInteger(connected) && Number.isSafeInteger(total) && connected <= total
    ? { connected, total }
    : null;
}

/** 只读存活实例，不为查看菜单重启会话或连接 MCP。旧 HMR 实例没有读取方法时返回空列表。 */
export function readSessionMcpSnapshot(sessionId: string, session: {
  isAlive(): boolean;
  getMcpServerStates?: () => McpMenuServerStatus[];
  getMcpServerCounts?: () => SessionMcpCounts | null | undefined;
} | undefined): SessionMcpSnapshot {
  const live = session?.isAlive() === true;
  const servers = live ? session?.getMcpServerStates?.() ?? [] : [];
  const externalCounts = live ? session?.getMcpServerCounts?.() : undefined;
  // 非适配器会话始终按 Pi 内置 host 统计；null 则保留适配器明确报告的未知状态。
  const counts = externalCounts === undefined
    ? { connected: servers.filter((server) => server.state === "ready").length, total: servers.length }
    : externalCounts;
  return {
    sessionId,
    live,
    counts: counts && { connected: counts.connected, total: counts.total },
    servers: servers.map(({ name, scope, state }) => ({ name, scope, state })),
  };
}
