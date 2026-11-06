import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isolateSessionEntryPersistence } = await jiti.import("./session-message-persistence.ts");
const { SessionDiskInspector } = await jiti.import("./session-disk-freshness.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-message-persistence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  isolateSessionEntryPersistence(manager);
  return manager;
}

function assistant() {
  return { role: "assistant", content: [], timestamp: Date.now() };
}

function toolResult() {
  return {
    role: "toolResult",
    toolCallId: "replace-first",
    toolName: "replace",
    content: [{ type: "text", text: "In batch 1" }],
    details: { batch: { id: 1, size: 2, last: false, total: 2 } },
    isError: false,
    timestamp: Date.now(),
  };
}

test("批次中止后修改已返回的结果，不污染磁盘、内存历史或模型上下文", (t) => {
  const manager = fixture(t);
  manager.appendMessage(assistant());
  const file = manager.getSessionFile();
  const result = toolResult();
  const id = manager.appendMessage(result);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");

  // 模拟 hashline 后续成员失败时回头修改首个工具结果的共享 details。
  result.details.batch.aborted = true;
  result.details.batch.abortMessage = "[E_OP_ABORTED] Batch 1 aborted";
  result.content[0].text = "changed by extension";
  manager.appendMessage({ ...toolResult(), toolCallId: "replace-second", isError: true });

  assert.equal(inspector.inspect(file), "current");
  const stored = manager.getEntry(id).message;
  const persisted = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).find((entry) => entry.id === id).message;
  assert.deepEqual(stored, persisted);
  assert.equal(stored.details.batch.aborted, undefined);
  assert.equal(stored.content[0].text, "In batch 1");
  assert.equal(manager.buildSessionContext().messages.find((message) => message.toolCallId === result.toolCallId).content[0].text, "In batch 1");
});

test("SDK 延迟首轮写盘期间，工具结果快照也保持保存时的内容", (t) => {
  const manager = fixture(t);
  const file = manager.getSessionFile();
  const result = toolResult();
  const id = manager.appendMessage(result);
  result.details.batch.aborted = true;
  result.details.batch.abortMessage = "[E_OP_ABORTED]";
  manager.appendMessage(assistant());

  assert.equal(new SessionDiskInspector(manager, true).inspect(file), "current");
  const reopened = SessionManager.open(file);
  assert.equal(reopened.getEntry(id).message.details.batch.aborted, undefined);
});

test("安装快照隔离后，外部同 ID 改写工具结果仍被识别", (t) => {
  const manager = fixture(t);
  manager.appendMessage(assistant());
  const id = manager.appendMessage(toolResult());
  const file = manager.getSessionFile();
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");

  const entries = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  entries.find((entry) => entry.id === id).message.details.batch.aborted = true;
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  assert.equal(inspector.inspect(file), "changed");
  assert.equal(manager.getEntry(id).message.details.batch.aborted, undefined);
});

test("扩展保存活动对象后原地修改（pi-goal 的 goal-state），内存历史仍与磁盘一致", (t) => {
  const manager = fixture(t);
  manager.appendMessage(assistant());
  const file = manager.getSessionFile();
  // pi-goal：serializeGoalState 返回 { goal }，之后每轮原地累加用量再保存一次。
  const goal = { id: "goal-1", status: "active", tokensUsed: 100, updatedAt: 1 };
  const firstId = manager.appendCustomEntry("goal-state", { goal });
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");

  goal.tokensUsed = 200;
  goal.updatedAt = 2;
  const secondId = manager.appendCustomEntry("goal-state", { goal });
  goal.tokensUsed = 300;

  assert.equal(inspector.inspect(file), "current");
  assert.equal(new SessionDiskInspector(manager, true).inspect(file), "current");
  assert.equal(manager.getEntry(firstId).data.goal.tokensUsed, 100);
  assert.equal(manager.getEntry(secondId).data.goal.tokensUsed, 200);
  // 扩展按最后一条 entry 恢复状态：读回的是保存时的值，与重开文件得到的一致。
  assert.deepEqual(SessionManager.open(file).getEntry(secondId).data, manager.getEntry(secondId).data);
});

test("扩展消息的 content 与 details 也按保存时的内容快照", (t) => {
  const manager = fixture(t);
  manager.appendMessage(assistant());
  const file = manager.getSessionFile();
  const content = [{ type: "text", text: "report v1" }];
  const details = { round: 1 };
  const id = manager.appendCustomMessageEntry("shadow-report", content, true, details);
  content[0].text = "report v2";
  details.round = 2;

  assert.equal(new SessionDiskInspector(manager, true).inspect(file), "current");
  const stored = manager.getEntry(id);
  assert.equal(stored.content[0].text, "report v1");
  assert.equal(stored.details.round, 1);
  assert.equal(stored.display, true);
});

test("纯字符串与缺省字段保持原样，外部同 ID 改写自定义 entry 仍被识别", (t) => {
  const manager = fixture(t);
  manager.appendMessage(assistant());
  const file = manager.getSessionFile();
  const emptyId = manager.appendCustomEntry("marker");
  const messageId = manager.appendCustomMessageEntry("note", "plain", false);
  assert.equal(manager.getEntry(emptyId).data, undefined);
  assert.equal(manager.getEntry(messageId).content, "plain");
  assert.equal(manager.getEntry(messageId).details, undefined);

  const stateId = manager.appendCustomEntry("goal-state", { goal: { tokensUsed: 1 } });
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  const entries = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  entries.find((entry) => entry.id === stateId).data.goal.tokensUsed = 999;
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(inspector.inspect(file), "changed");
});
