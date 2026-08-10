import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("会话写入命令完成后立即失效会话列表缓存", () => {
  assert.match(source, /import \{ invalidateSessionListCache, resolveSessionPath \}/);
  assert.match(source, /const result = await existing\.send\(body\);\s*if \(shouldInvalidateSessionList\(body\.type\)\) invalidateSessionListCache\(\);/);
  assert.match(source, /const result = await session\.send\(body\);\s*if \(shouldInvalidateSessionList\(body\.type\)\) invalidateSessionListCache\(\);/);
});

test("查询命令不淘汰会话列表缓存", () => {
  const helperSource = source.slice(
    source.indexOf("function shouldInvalidateSessionList"),
    source.indexOf("// POST /api/agent/[id]"),
  );

  assert.match(helperSource, /"get_state"/);
  assert.match(helperSource, /"get_tools"/);
  assert.match(helperSource, /"get_commands"/);
  assert.match(helperSource, /"get_session_stats"/);
});
