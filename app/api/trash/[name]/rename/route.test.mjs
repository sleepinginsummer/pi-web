import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../../../../..") } });
const titles = await jiti.import("../../../../../lib/session-file-title.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
let generate;
// 只替换外部模型生成边界，路由、JSONL 标题保存和恢复使用真实实现。
titles.generateTitleForSessionFile = (...args) => generate(...args);
const { POST } = await jiti.import("./route.ts");
const { listTrashedSessions, restoreTrashedSession } = await jiti.import("../../../../../lib/trash.ts");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trash-ai-rename-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const name = "2026-01-02T00-00-00-000Z_session.jsonl";
  const filePath = path.join(directory, "trash", name);
  fs.mkdirSync(path.dirname(filePath));
  const timestamp = "2026-01-01T00:00:00Z";
  fs.writeFileSync(filePath, [
    { type: "session", version: 3, id: "ai-rename", timestamp, cwd: "/tmp/trash-ai-check" },
    { type: "message", id: "u", parentId: null, timestamp, message: { role: "user", content: "用户问题" } },
    { type: "message", id: "a", parentId: "u", timestamp, message: { role: "assistant", content: [{ type: "text", text: "关键回复" }] } },
    { type: "session_info", id: "n", parentId: "a", timestamp, name: "原标题" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { name, filePath };
}

const request = (name) => POST(new Request("http://localhost/api/trash/rename", { method: "POST" }), { params: Promise.resolve({ name }) });

test("AI 重命名覆盖已有标题，保留归档信息和正文，恢复后仍使用新标题", async (t) => {
  const { name, filePath } = fixture(t);
  const before = listTrashedSessions()[0];
  let calls = 0;
  generate = async (target, options) => {
    calls++;
    assert.equal(target, filePath);
    assert.deepEqual(options, { overwrite: true });
    SessionManager.open(target).appendSessionInfo("AI 生成的新标题");
    return "AI 生成的新标题";
  };
  const response = await request(name);
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.equal(calls, 1);
  assert.equal(session.title, "AI 生成的新标题");
  assert.equal(session.deleted, before.deleted);
  assert.equal(session.created, before.created);
  assert.equal(session.originalPath, before.originalPath);
  const { restoredPath } = restoreTrashedSession(name);
  const manager = SessionManager.open(restoredPath);
  assert.equal(manager.getSessionName(), "AI 生成的新标题");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "message").length, 2);
});

test("非法路径和不存在文件不调用 AI", async (t) => {
  fixture(t);
  generate = () => { throw new Error("不应调用生成器"); };
  assert.equal((await request("../escape.jsonl")).status, 400);
  assert.equal((await request("missing.jsonl")).status, 404);
});

test("生成跳过和失败返回错误并保留原标题", async (t) => {
  const { name } = fixture(t);
  generate = async () => null;
  assert.equal((await request(name)).status, 409);
  generate = async () => { throw new Error("模型生成失败"); };
  const response = await request(name);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "模型生成失败");
  assert.equal(listTrashedSessions()[0].title, "原标题");
});
