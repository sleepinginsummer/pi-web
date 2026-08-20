import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("新会话思考等级复用共享守卫且不接受 auto", () => {
  assert.match(source, /import \{ isThinkingLevel, type ThinkingLevel \} from "@\/lib\/thinking-levels"/);
  assert.match(source, /if \(isThinkingLevel\(value\)\) return value/);
  assert.doesNotMatch(source, /const THINKING_LEVELS/);
});

test("auto 通过省略 thinkingLevel 字段表达", () => {
  assert.match(source, /\.\.\.\(explicitThinkingLevel \? \{ thinkingLevel: explicitThinkingLevel \} : \{\}\)/);
});

test("新会话仅在显式关闭时初始化 Shadow，失败时返回同一 runtime", () => {
  assert.match(source, /if \(shadowMindEnabled === false\)/);
  assert.match(source, /session\.send\(\{ type: "set_shadow_mind_enabled", enabled: false \}\)/);
  assert.match(source, /kind: "initialization-failed"/);
  assert.match(source, /sessionId: realSessionId/);
  assert.match(source, /satisfies NewSessionMaterializationResult/);
  assert.match(source, /operation === "finalize-existing"/);
  assert.match(source, /wrapper\.sessionId !== requestedSessionId/);
  assert.match(source, /realpathSync\(wrapper\.cwd\) !== realpathSync\(cwd\)/);
  assert.match(source, /kind: "materialization-failed"/);
  assert.ok(
    source.indexOf('type: "set_shadow_mind_enabled"') < source.indexOf("const state = await session.send"),
    "Shadow 预设必须先于首条 prompt 和状态返回生效",
  );
});
