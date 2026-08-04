import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("恢复会话时任一消息统计有效即可生成标题", () => {
  assert.match(source, /\(sessionStats\?\.userMessages \?\? 0\) > 0/);
  assert.match(source, /\(sessionStats\?\.totalMessages \?\? 0\) > 0/);
  assert.match(source, /selectedSession\.messageCount > 0/);
});
