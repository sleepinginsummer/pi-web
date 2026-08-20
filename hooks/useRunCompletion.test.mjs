import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useRunCompletion.ts", import.meta.url), "utf8");

test("hook 将 begin 和 settle 委托给独立生命周期控制器", () => {
  assert.match(source, /new RunCompletionController\(\)/);
  assert.match(source, /controllerRef\.current\?\.beginRun\(runId\)/);
  assert.match(source, /controllerRef\.current\?\.settleRun\(runId, sessionId\)/);
  assert.match(source, /setCompletion\(nextCompletion\)/);
});
