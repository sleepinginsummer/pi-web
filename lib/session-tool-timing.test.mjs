import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { SessionToolTimings, sessionToolTimings } = await jiti.import("./session-tool-timing.ts");
const { isolateSessionEntryPersistence } = await jiti.import("./session-message-persistence.ts");
const { SessionDiskInspector } = await jiti.import("./session-disk-freshness.ts");
const { toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");

function fixture() {
  let wall = 1_700_000_000_000, mono = 100;
  const tracker = new SessionToolTimings(() => wall, () => mono);
  return { tracker, advance(ms) { wall += ms; mono += ms; }, get wall() { return wall; } };
}
const start = (id = "call") => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash" });
const end = (id = "call") => ({ type: "tool_execution_end", toolCallId: id, toolName: "bash", durationMs: 30 });
const result = (id = "call") => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [], timestamp: Date.now(), durationMs: 30 });

test("从工具参数开始出现时记录时间，并行调用各自结束且 SSE 保留开始时刻", () => {
  const f = fixture();
  const appeared = f.tracker.observe({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "call" }] } } });
  assert.equal(toClientAgentEvent(appeared).assistantMessageEvent.startedAt, f.wall);
  f.advance(2000);
  assert.equal(f.tracker.observe(start()).elapsedMs, 2000);
  const other = f.tracker.observe(start("other"));
  f.advance(3000);
  const done = f.tracker.observe(end());
  assert.equal(done.durationMs, 5000);
  assert.equal(toClientAgentEvent(done).startedAt, appeared.assistantMessageEvent.startedAt);
  assert.equal(f.tracker.message(result()).toolTiming.durationMs, 5000);
  assert.equal(f.tracker.observe(end("other")).durationMs, 3000);
  assert.equal(other.startedAt, appeared.assistantMessageEvent.startedAt + 2000);
});

test("codemode 同名并行子调用按序号计时，不修改 SDK 快照，完成后与重连副本时间一致", () => {
  const f = fixture();
  f.tracker.observe({ ...start("parent"), toolName: "codemode" });
  const update = (calls) => ({ type: "tool_execution_update", toolCallId: "parent", toolName: "codemode", partialResult: { content: [], details: { calls } } });
  const calls = [{ id: "parent/?", name: "bash", status: "running" }];
  const first = f.tracker.observe(update(calls));
  assert.equal(calls[0].startedAt, undefined);
  f.advance(1000);
  calls.push({ id: "parent/?", name: "bash", status: "running" });
  const second = f.tracker.observe(update(calls));
  assert.equal(second.partialResult.details.calls[0].startedAt, first.partialResult.details.calls[0].startedAt);
  assert.equal(second.partialResult.details.calls[1].startedAt, f.wall);
  f.advance(2000);
  calls[0] = { ...calls[0], id: "parent/1", status: "ok", durationMs: 2999 };
  const finished = f.tracker.observe(update(calls));
  assert.equal(finished.partialResult.details.calls[0].durationMs, 3000);
  f.advance(5000);
  const replay = f.tracker.observe(update(calls));
  assert.deepEqual(replay.partialResult.details.calls[0], finished.partialResult.details.calls[0]);
  f.tracker.observe({ ...end("parent"), toolName: "codemode", result: { details: { calls } } });
  const final = f.tracker.message({ ...result("parent"), toolName: "codemode", details: { calls } });
  assert.equal(final.details.calls[1].status, "cancelled");
  assert.equal(final.details.calls[1].durationMs, 7000);
});

test("计时元数据随 JSONL 保存，重新打开保持一致且不造成外部写入冲突", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-timing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  isolateSessionEntryPersistence(manager);
  const tracker = sessionToolTimings(manager);
  tracker.observe(start());
  tracker.observe(end());
  const source = result();
  const id = manager.appendMessage(source);
  manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
  assert.equal(source.toolTiming, undefined);
  const saved = manager.getEntry(id).message;
  const reopened = SessionManager.open(manager.getSessionFile()).getEntry(id).message;
  assert.deepEqual(reopened.toolTiming, saved.toolTiming);
  assert.ok(saved.toolTiming.startedAt > 0);
  assert.ok(saved.toolTiming.durationMs >= 0);
  assert.equal(new SessionDiskInspector(manager, true).inspect(manager.getSessionFile()), "current");
});

test("手动 bash 在 SDK 延迟写入前结束，保存时不能把等待主回合结束算进去", () => {
  const f = fixture();
  const shell = f.tracker.beginShell("demo");
  f.advance(2400);
  const final = f.tracker.finishShell(shell);
  f.advance(10000);
  const persisted = f.tracker.message({ role: "bashExecution", command: "demo", output: "ok", exitCode: 0 }, true);
  assert.deepEqual(persisted.toolTiming, final);
  assert.equal(final.durationMs, 2400);
});
