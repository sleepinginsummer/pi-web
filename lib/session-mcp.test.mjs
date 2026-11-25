import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSessionMcpSnapshot } = await jiti.import("./session-mcp.ts");

test("启用但未连接的 MCP 进入菜单数量，并只返回展示字段", () => {
  assert.deepEqual(readSessionMcpSnapshot("session-a", {
    isAlive: () => true,
    getMcpServerStates: () => [{ name: "docs", scope: "global", state: "not-connected", config: { token: "private" } }],
  }), {
    sessionId: "session-a", live: true,
    servers: [{ name: "docs", scope: "global", state: "not-connected" }],
  });
});
test("MCP 菜单只读目标会话的连接且不泄露配置或日志", () => {
  const servers = [{ name: "docs", scope: "global", state: "ready", error: "private", stderr: "private", config: { token: "private" } }];
  assert.deepEqual(readSessionMcpSnapshot("session-a", {
    isAlive: () => true,
    getMcpServerStates: () => servers,
  }), {
    sessionId: "session-a", live: true,
    servers: [{ name: "docs", scope: "global", state: "ready" }],
  });
});

test("已回收、关闭或旧 HMR 会话不会为了读取 MCP 而启动连接", () => {
  assert.deepEqual(readSessionMcpSnapshot("missing", undefined), { sessionId: "missing", live: false, servers: [] });
  assert.deepEqual(readSessionMcpSnapshot("closed", {
    isAlive: () => false,
    getMcpServerStates: () => { throw new Error("不应读取已关闭 host"); },
  }), { sessionId: "closed", live: false, servers: [] });
  assert.deepEqual(readSessionMcpSnapshot("legacy", { isAlive: () => true }), { sessionId: "legacy", live: true, servers: [] });
});
