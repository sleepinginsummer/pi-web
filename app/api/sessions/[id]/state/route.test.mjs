import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const agentRoute = await readFile(new URL("../../../agent/[id]/route.ts", import.meta.url), "utf8");

test("两个会话状态接口复用统一 alive/busy 快照", () => {
  assert.match(stateRoute, /getRpcSessionSnapshot\(id\)/);
  assert.match(agentRoute, /getRpcSessionSnapshot\(id\)/);
  assert.doesNotMatch(stateRoute, /running:/);
  assert.doesNotMatch(agentRoute.slice(agentRoute.indexOf("export async function GET")), /running:/);
});
