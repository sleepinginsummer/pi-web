import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("会话写入命令共用唯一发送与缓存失效路径", () => {
  assert.match(source, /import \{ invalidateSessionListCache, resolveSessionPath \}/);
  assert.equal((source.match(/const result = await session\.send\(body\)/g) ?? []).length, 1);
  assert.match(source, /if \(shouldInvalidateSessionList\(body\.type\)\) invalidateSessionListCache\(\);/);
});

test("消息提交成功后直接确认，不被后续状态读取推翻", () => {
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("// GET /api/agent/[id]"));
  assert.match(postSource, /data: \{ accepted: true, mode \}/);
  assert.doesNotMatch(postSource, /getRpcSessionSnapshot/);
});

test("Shadow prompt interception returns setting state instead of submit acknowledgement", () => {
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("// GET /api/agent/[id]"));
  assert.match(postSource, /isShadowSettingCommandResult\(result\)/);
  assert.ok(postSource.indexOf("isShadowSettingCommandResult(result)") < postSource.indexOf("const mode = getSubmitMode"));
  assert.match(postSource, /data: \{ enabled: result\.enabled \}/);
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
