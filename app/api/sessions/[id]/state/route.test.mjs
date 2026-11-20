import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const agentRoute = await readFile(new URL("../../../agent/[id]/route.ts", import.meta.url), "utf8");

test("两个会话状态接口复用统一 alive/busy 快照", () => {
  // 允许带 options（agent 路由按 ?systemPrompt=0 决定要不要提示词），但必须仍走统一快照。
  assert.match(stateRoute, /getRpcSessionSnapshot\(id\b/);
  assert.match(agentRoute, /getRpcSessionSnapshot\(id\b/);
  // 状态读取从不带系统提示词：它几乎就是整份回复的大小，只有系统面板按需单独读。
  assert.doesNotMatch(stateRoute, /includeSystemPrompt/);
  assert.match(agentRoute, /includeSystemPrompt/);
  assert.doesNotMatch(stateRoute, /running:/);
  assert.doesNotMatch(agentRoute.slice(agentRoute.indexOf("export async function GET")), /running:/);
});
