import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createClonedSession, createForkedSession } = await jiti.import("./session-fork.ts");

function createSource(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-fork-"));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const source = path.join(sessionDir, "2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: root,
  };
  fs.writeFileSync(source, `${[header, ...entries].map(JSON.stringify).join("\n")}\n`, "utf8");
  const original = fs.readFileSync(source, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { source, original };
}

function message(id, parentId, role, content, extra = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role, content, ...extra },
  };
}

test("首条用户消息分叉会创建仅含合法 header 的持久化会话", (t) => {
  const firstUser = message("user-1", null, "user", "你好");
  const { source, original } = createSource(t, [firstUser]);

  const result = createForkedSession(source, firstUser.id);

  assert.equal(fs.existsSync(result.newSessionFile), true);
  const lines = fs.readFileSync(result.newSessionFile, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "session");
  assert.equal(header.id, result.newSessionId);
  assert.equal(header.parentSession, source);
  assert.equal(SessionManager.open(result.newSessionFile).getSessionId(), result.newSessionId);
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("用户消息分叉复制到该消息之前", (t) => {
  const firstUser = message("user-1", null, "user", "问题一");
  const assistant = message("assistant-1", firstUser.id, "assistant", [{ type: "text", text: "回答一" }]);
  const secondUser = message("user-2", assistant.id, "user", "问题二");
  const { source } = createSource(t, [firstUser, assistant, secondUser]);

  const result = createForkedSession(source, secondUser.id);
  const entries = SessionManager.open(result.newSessionFile).getEntries();

  assert.deepEqual(entries.map((entry) => entry.id), [firstUser.id, assistant.id]);
});

test("助手消息分叉保留当前回答", (t) => {
  const user = message("user-1", null, "user", "问题");
  const assistant = message("assistant-1", user.id, "assistant", [{ type: "text", text: "回答" }]);
  const { source } = createSource(t, [user, assistant]);

  const result = createForkedSession(source, assistant.id);
  const manager = SessionManager.open(result.newSessionFile);

  assert.deepEqual(manager.getEntries().map((entry) => entry.id), [user.id, assistant.id]);
  assert.equal(manager.getHeader()?.parentSession, source);
});

test("助手工具调用分叉会包含全部匹配的工具结果", (t) => {
  const user = message("user-1", null, "user", "执行工具");
  const assistant = message("assistant-1", user.id, "assistant", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    { type: "toolCall", id: "call-2", name: "read", arguments: {} },
  ]);
  const firstResult = message("result-1", assistant.id, "toolResult", [], { toolCallId: "call-1" });
  const secondResult = message("result-2", firstResult.id, "toolResult", [], { toolCallId: "call-2" });
  const nextAssistant = message("assistant-2", secondResult.id, "assistant", [{ type: "text", text: "完成" }]);
  const { source } = createSource(t, [user, assistant, firstResult, secondResult, nextAssistant]);

  const result = createForkedSession(source, assistant.id);
  const ids = SessionManager.open(result.newSessionFile).getEntries().map((entry) => entry.id);

  assert.deepEqual(ids, [user.id, assistant.id, firstResult.id, secondResult.id]);
});

test("助手工具调用未完成时拒绝分叉且不修改源文件", (t) => {
  const user = message("user-1", null, "user", "执行工具");
  const assistant = message("assistant-1", user.id, "assistant", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]);
  const { source, original } = createSource(t, [user, assistant]);

  assert.throws(
    () => createForkedSession(source, assistant.id),
    /unfinished tool calls/,
  );
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("持久化后的校验失败会清理本次创建的会话文件", (t) => {
  const firstUser = message("user-1", null, "user", "你好");
  const { source } = createSource(t, [firstUser]);
  const before = new Set(fs.readdirSync(path.dirname(source)));
  const originalOpen = SessionManager.open;
  let openCount = 0;
  SessionManager.open = function patchedOpen(...args) {
    openCount += 1;
    if (openCount === 3) throw new Error("validation failed");
    return originalOpen.apply(this, args);
  };

  try {
    assert.throws(() => createForkedSession(source, firstUser.id), /validation failed/);
  } finally {
    SessionManager.open = originalOpen;
  }
  assert.deepEqual(new Set(fs.readdirSync(path.dirname(source))), before);
});

test("无效或非消息节点不能分叉", (t) => {
  const custom = { type: "custom", id: "custom-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", customType: "test" };
  const { source } = createSource(t, [custom]);

  assert.throws(() => createForkedSession(source, "missing"), /Invalid message entry ID/);
  assert.throws(() => createForkedSession(source, custom.id), /Invalid message entry ID/);
});

test("复制当前分支会保留叶节点并且不修改源文件", (t) => {
  const user = message("user-1", null, "user", "执行工具");
  const assistant = message("assistant-1", user.id, "assistant", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]);
  const resultEntry = message("result-1", assistant.id, "toolResult", [], { toolCallId: "call-1" });
  const finalAssistant = message("assistant-2", resultEntry.id, "assistant", [{ type: "text", text: "完成" }]);
  const { source, original } = createSource(t, [user, assistant, resultEntry, finalAssistant]);

  const result = createClonedSession(source, finalAssistant.id);
  const cloned = SessionManager.open(result.newSessionFile);

  assert.deepEqual(cloned.getEntries().map((entry) => entry.id), [user.id, assistant.id, resultEntry.id, finalAssistant.id]);
  assert.equal(cloned.getHeader()?.parentSession, source);
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("没有助手回复的分支不能复制", (t) => {
  const user = message("user-1", null, "user", "尚未回复");
  const { source } = createSource(t, [user]);
  assert.throws(() => createClonedSession(source, user.id), /assistant-free/);
});

test("存在未完成工具调用的分支不能复制且不创建文件", (t) => {
  const user = message("user-1", null, "user", "执行工具");
  const assistant = message("assistant-1", user.id, "assistant", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]);
  const { source, original } = createSource(t, [user, assistant]);
  const sessionDir = path.dirname(source);
  const before = new Set(fs.readdirSync(sessionDir));

  assert.throws(
    () => createClonedSession(source, assistant.id),
    /unfinished tool calls/,
  );
  assert.deepEqual(new Set(fs.readdirSync(sessionDir)), before);
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("最新压缩边界之前的未完成工具调用不阻止复制", (t) => {
  const user = message("user-1", null, "user", "执行工具");
  const interrupted = message("assistant-1", user.id, "assistant", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]);
  const keptUser = message("user-2", interrupted.id, "user", "继续");
  const compaction = {
    type: "compaction",
    id: "compact-1",
    parentId: keptUser.id,
    timestamp: "2026-01-01T00:00:03.000Z",
    summary: "Earlier interrupted work",
    firstKeptEntryId: keptUser.id,
    tokensBefore: 100,
  };
  const finalAssistant = message("assistant-2", compaction.id, "assistant", [{ type: "text", text: "完成" }]);
  const { source } = createSource(t, [user, interrupted, keptUser, compaction, finalAssistant]);

  const result = createClonedSession(source, finalAssistant.id);

  assert.ok(fs.existsSync(result.newSessionFile));
});
