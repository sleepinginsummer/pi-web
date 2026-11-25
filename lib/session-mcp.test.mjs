import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSessionMcpSnapshot, readMcpAdapterCounts } = await jiti.import("./session-mcp.ts");

test("启用但未连接的 MCP 进入菜单数量，并只返回展示字段", () => {
  assert.deepEqual(readSessionMcpSnapshot("session-a", {
    isAlive: () => true,
    getMcpServerStates: () => [{ name: "docs", scope: "global", state: "not-connected", config: { token: "private" } }],
  }), {
    sessionId: "session-a", live: true, counts: { connected: 0, total: 1 },
    servers: [{ name: "docs", scope: "global", state: "not-connected" }],
  });
});
test("MCP 菜单只读目标会话的连接且不泄露配置或日志", () => {
  const servers = [{ name: "docs", scope: "global", state: "ready", error: "private", stderr: "private", config: { token: "private" } }];
  assert.deepEqual(readSessionMcpSnapshot("session-a", {
    isAlive: () => true,
    getMcpServerStates: () => servers,
  }), {
    sessionId: "session-a", live: true, counts: { connected: 1, total: 1 },
    servers: [{ name: "docs", scope: "global", state: "ready" }],
  });
});

test("已回收、关闭或旧 HMR 会话不会为了读取 MCP 而启动连接", () => {
  assert.deepEqual(readSessionMcpSnapshot("missing", undefined), { sessionId: "missing", live: false, counts: { connected: 0, total: 0 }, servers: [] });
  assert.deepEqual(readSessionMcpSnapshot("closed", {
    isAlive: () => false,
    getMcpServerStates: () => { throw new Error("不应读取已关闭 host"); },
  }), { sessionId: "closed", live: false, counts: { connected: 0, total: 0 }, servers: [] });
  assert.deepEqual(readSessionMcpSnapshot("legacy", { isAlive: () => true }), { sessionId: "legacy", live: true, counts: { connected: 0, total: 0 }, servers: [] });
});

test("适配器启用但未触发连接时保留 0/1，而不是按空的内置 host 报零", () => {
  assert.deepEqual(readSessionMcpSnapshot("adapter", {
    isAlive: () => true,
    getMcpServerStates: () => [],
    getMcpServerCounts: () => ({ connected: 0, total: 1 }),
  }), { sessionId: "adapter", live: true, counts: { connected: 0, total: 1 }, servers: [] });
});

const adapterCommands = [{ name: "mcp", sourceInfo: { path: "/agent/npm/node_modules/pi-mcp-adapter/index.ts" } }];

test("读取适配器实际发布的完整、精简和彩色计数，不把已启用视为已连接", () => {
  for (const [status, counts] of [
    ["\u001b[38;5;5m🔌 MCP: 1 server enabled\u001b[39m", { connected: 0, total: 1 }],
    ["MCP 0/1", { connected: 0, total: 1 }],
    ["MCP 1/1", { connected: 1, total: 1 }],
    ["MCP: 3 servers enabled (1 connected) (2 disabled)", { connected: 1, total: 3 }],
    ["🔌 MCP: 0 servers enabled (1 disabled)", { connected: 0, total: 0 }],
  ]) assert.deepEqual(readMcpAdapterCounts(adapterCommands, status), counts, status);
  assert.deepEqual(readMcpAdapterCounts([{ name: "mcp", sourceInfo: { path: "C:\\agent\\node_modules\\pi-mcp-adapter\\index.ts" } }], "MCP 0/1"), { connected: 0, total: 1 });
});

test("只认当前会话适配器的计数，未知或关闭的状态栏不会伪装成零", () => {
  for (const commands of [[], [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }], [{ name: "mcp", sourceInfo: { path: "/another/index.ts" } }]]) {
    assert.equal(readMcpAdapterCounts(commands, "MCP 0/1"), undefined);
  }
  for (const status of [undefined, "", "Connecting…", "MCP 2/1", "MCP 9007199254740992/9007199254740992", "MCP 0/1 extra"]) {
    assert.equal(readMcpAdapterCounts(adapterCommands, status), null);
  }
  assert.equal(readSessionMcpSnapshot("adapter", { isAlive: () => true, getMcpServerCounts: () => null }).counts, null);
  const closed = readSessionMcpSnapshot("closed", {
    isAlive: () => false,
    getMcpServerCounts: () => { throw new Error("关闭会话不应读取计数"); },
  });
  assert.deepEqual(closed.counts, { connected: 0, total: 0 });
});

test("Pi 内置 MCP 使用自己的连接状态，未触发和空闲释放都保留启用数量", () => {
  const commands = [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }];
  let servers = [{ name: "docs", scope: "global", state: "not-connected" }];
  const session = {
    isAlive: () => true,
    getMcpServerStates: () => servers,
    // 模拟卸载适配器后尚未清理的状态栏：内置 MCP 不能使用这份计数。
    getMcpServerCounts: () => readMcpAdapterCounts(commands, "MCP 9/9"),
  };
  const counts = () => readSessionMcpSnapshot("builtin", session).counts;
  assert.deepEqual(counts(), { connected: 0, total: 1 });
  servers = [{ name: "docs", scope: "global", state: "ready" }];
  assert.deepEqual(counts(), { connected: 1, total: 1 });
  servers = [{ name: "docs", scope: "global", state: "not-connected" }];
  assert.deepEqual(counts(), { connected: 0, total: 1 });
  servers = [
    { name: "docs", scope: "global", state: "ready" },
    { name: "search", scope: "project", state: "connecting" },
    { name: "auth", scope: "global", state: "needs-auth" },
    { name: "failed", scope: "global", state: "failed" },
  ];
  assert.deepEqual(counts(), { connected: 1, total: 4 });
});

test("MCP 管理方切换后重新选择来源，适配器与 Pi 内置计数不互相覆盖", () => {
  let commands = adapterCommands;
  let servers = [];
  const session = {
    isAlive: () => true,
    getMcpServerStates: () => servers,
    getMcpServerCounts: () => readMcpAdapterCounts(commands, "MCP 0/3"),
  };
  const counts = () => readSessionMcpSnapshot("switching", session).counts;
  assert.deepEqual(counts(), { connected: 0, total: 3 });
  commands = [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }];
  servers = [{ name: "native", scope: "global", state: "ready" }];
  assert.deepEqual(counts(), { connected: 1, total: 1 });
  commands = adapterCommands;
  servers = [];
  assert.deepEqual(counts(), { connected: 0, total: 3 });
});
