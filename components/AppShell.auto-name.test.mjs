import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const topBarSource = fs.readFileSync(new URL("./AppTopBar.tsx", import.meta.url), "utf8");
const autoNameSource = fs.readFileSync(new URL("../hooks/useSessionAutoName.ts", import.meta.url), "utf8");

test("恢复会话时任一消息统计有效即可生成标题", () => {
  assert.match(topBarSource, /\(session\.stats\?\.userMessages \?\? 0\) > 0/);
  assert.match(topBarSource, /\(session\.stats\?\.totalMessages \?\? 0\) > 0/);
  assert.match(topBarSource, /session\.messageCount > 0/);
});

test("手动标题操作由客户端 helper 管理协议", () => {
  assert.match(autoNameSource, /const operationId = crypto\.randomUUID\(\)/);
  assert.match(autoNameSource, /runSessionTitleOperation\(\{ sessionId, operationId \}\)/);
  assert.doesNotMatch(autoNameSource, /session_title_skipped|new EventSource\(/);
});
