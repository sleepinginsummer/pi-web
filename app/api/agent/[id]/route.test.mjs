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

test("prompt 在服务端接受前失败时返回明确拒绝", () => {
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("// GET /api/agent/[id]"));
  assert.match(postSource, /commandType === "prompt"/);
  assert.match(postSource, /code: "prompt_rejected", accepted: false/);
});

test("消息提交同时校验客户端、路由和运行时会话身份", () => {
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("// GET /api/agent/[id]"));
  assert.match(source, /function submitIdentityError/);
  assert.equal((postSource.match(/submitIdentityError\(id, body/g) ?? []).length, 2);
  assert.match(postSource, /submitIdentityError\(id, body, session\.sessionId\)/);
  assert.match(source, /code: "session_identity_mismatch"/);
  assert.match(postSource, /会话消息提交已接受/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(postSource, /clientSessionId: body\.clientSessionId/);
  assert.match(postSource, /runtimeSessionId: session\.sessionId/);
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

test("发送前拒绝旧 leaf 写入，但放行停止与只读命令", () => {
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("// GET /api/agent/[id]"));
  assert.match(postSource, /current\.diskFreshness\(\)/);
  assert.match(postSource, /code: "session_external_write", accepted: false/);
  assert.match(postSource, /current\.evictIfDiskAhead\(\)/);
  assert.match(postSource, /canRunWithExternalSessionChange\(body\.type\)/);
  assert.match(postSource, /error instanceof SessionFileConflictError/);
  assert.ok(postSource.indexOf("current.diskFreshness()") < postSource.indexOf("session.send(body)"));
});
