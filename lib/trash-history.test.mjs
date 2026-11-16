import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionContext } = await jiti.import("./session-reader.ts");

const timestamp = "2026-01-01T00:00:00Z";
const user = (id, parentId, text) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content: text } });
const assistant = (id, parentId, text) => ({ type: "message", id, parentId, timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });

test("回收站完整历史保留多次压缩前的用户消息，并排除其它分支", () => {
  const entries = [
    user("u1", null, "最早问题"), assistant("a1", "u1", "最早回复"),
    user("u2", "a1", "第二轮"), assistant("a2", "u2", "第二轮回复"),
    { type: "compaction", id: "c1", parentId: "a2", timestamp, summary: "摘要一", firstKeptEntryId: "a2", tokensBefore: 100 },
    user("u3", "c1", "第三轮"), assistant("a3", "u3", "第三轮回复"),
    { type: "compaction", id: "c2", parentId: "a3", timestamp, summary: "摘要二", firstKeptEntryId: "a3", tokensBefore: 100 },
    user("other", "a1", "其它分支"),
    { type: "custom", customType: "shadow-mind-event", id: "other-shadow", parentId: "other", timestamp, data: { kind: "run-start", data: { runId: "other-run", shadowId: "other-shadow" } } },
  ];
  const normal = buildSessionContext(entries, "c2");
  assert.equal(normal.messages[0].role, "assistant");
  const history = buildSessionContext(entries, "c2", { fullHistory: true });
  assert.deepEqual(history.entryIds, ["u1", "a1", "u2", "a2", "c1", "u3", "a3", "c2"]);
  assert.equal(history.messages[0].content, "最早问题");
  assert.equal(history.hasMore, false);
});

test("完整历史沿重命名后的叶子读取，不展示系统提示词", () => {
  const entries = [
    user("u1", null, "问题"), assistant("a1", "u1", "回复"),
    { type: "message", id: "system", parentId: "a1", timestamp, message: { role: "system", content: "系统提示词" } },
    { type: "session_info", id: "name", parentId: "system", timestamp, name: "新标题" },
  ];
  const history = buildSessionContext(entries, "name", { fullHistory: true });
  assert.deepEqual(history.entryIds, ["u1", "a1"]);
});
