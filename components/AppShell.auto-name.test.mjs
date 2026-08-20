import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("恢复会话时任一消息统计有效即可生成标题", () => {
  assert.match(source, /\(sessionStats\?\.userMessages \?\? 0\) > 0/);
  assert.match(source, /\(sessionStats\?\.totalMessages \?\? 0\) > 0/);
  assert.match(source, /selectedSession\.messageCount > 0/);
});

test("手动标题操作由客户端 helper 管理协议", () => {
  assert.match(source, /const operationId = crypto\.randomUUID\(\)/);
  assert.match(source, /runSessionTitleOperation\(\{ sessionId, operationId \}\)/);
  assert.doesNotMatch(source, /session_title_skipped|new EventSource\(/);
});
