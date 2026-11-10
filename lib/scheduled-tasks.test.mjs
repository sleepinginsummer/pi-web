import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./scheduled-tasks.ts");

function tempStore() {
  return join(mkdtempSync(join(tmpdir(), "pi-web-tasks-")), "tasks.json");
}

const base = { sessionId: "s1", cwd: "/p", name: "check", prompt: "look at CI" };

test("one-shot tasks need one schedule at least a minute ahead", async () => {
  const path = tempStore();
  const now = Date.UTC(2026, 10, 10, 1);
  await assert.rejects(store.createScheduledTask({ ...base }, now, path), /exactly one/);
  await assert.rejects(store.createScheduledTask({ ...base, delaySeconds: 10 }, now, path), /60 seconds/);
  await assert.rejects(store.createScheduledTask({ ...base, delaySeconds: 120, cron: "* * * * *" }, now, path), /exactly one/);
  await assert.rejects(store.createScheduledTask({ ...base, at: "tomorrow" }, now, path), /ISO 8601/);
  const task = await store.createScheduledTask({ ...base, delaySeconds: 120 }, now, path);
  assert.equal(task.nextRunAt, now + 120_000);
  assert.deepEqual(task.schedule, { kind: "once", at: now + 120_000 });
});

test("claiming a due one-shot task finishes it; a cron task moves to its next occurrence", async () => {
  const path = tempStore();
  const now = new Date(2026, 10, 10, 8, 0).getTime();
  const once = await store.createScheduledTask({ ...base, delaySeconds: 60 }, now, path);
  const cron = await store.createScheduledTask({ ...base, name: "daily", cron: "0 9 * * *" }, now, path);
  assert.deepEqual(await store.claimDueTasks(now + 30_000, path), []);

  // pi-web was down for two days: each task fires once.
  const later = new Date(2026, 10, 12, 10, 0).getTime();
  const claimed = await store.claimDueTasks(later, path);
  assert.deepEqual(claimed.map((task) => task.id).sort(), [once.id, cron.id].sort());
  const [afterOnce, afterCron] = [store.getScheduledTask(once.id, path), store.getScheduledTask(cron.id, path)];
  assert.equal(afterOnce.nextRunAt, null);
  assert.equal(afterOnce.enabled, false);
  assert.equal(afterOnce.runCount, 1);
  assert.equal(afterCron.nextRunAt, new Date(2026, 10, 13, 9, 0).getTime());
  assert.deepEqual(await store.claimDueTasks(later, path), []);
});

test("pausing and resuming a cron task skips the occurrences it missed", async () => {
  const path = tempStore();
  const now = new Date(2026, 10, 10, 8, 0).getTime();
  const task = await store.createScheduledTask({ ...base, cron: "0 9 * * *" }, now, path);
  await store.updateScheduledTask(task.id, { enabled: false }, { now }, path);
  const resumedAt = new Date(2026, 10, 12, 10, 0).getTime();
  const resumed = await store.updateScheduledTask(task.id, { enabled: true }, { now: resumedAt }, path);
  assert.equal(resumed.nextRunAt, new Date(2026, 10, 13, 9, 0).getTime());
});

test("a session only sees and changes its own tasks", async () => {
  const path = tempStore();
  const task = await store.createScheduledTask({ ...base, delaySeconds: 300 }, Date.now(), path);
  await assert.rejects(store.updateScheduledTask(task.id, { name: "x" }, { sessionId: "other" }, path), /in this session/);
  assert.equal(await store.deleteScheduledTask(task.id, { sessionId: "other" }, path), false);
  assert.deepEqual(store.listScheduledTasks({ sessionId: "other" }, path), []);
  assert.equal(await store.deleteScheduledTask(task.id, { sessionId: "s1" }, path), true);
});

test("a finished one-shot task cannot be resumed without a new time", async () => {
  const path = tempStore();
  const now = Date.now();
  const task = await store.createScheduledTask({ ...base, delaySeconds: 60 }, now, path);
  await store.claimDueTasks(now + 61_000, path);
  await assert.rejects(store.updateScheduledTask(task.id, { enabled: true }, {}, path), /already fired/);
  const again = await store.updateScheduledTask(task.id, { delaySeconds: 120 }, { now: now + 61_000 }, path);
  assert.equal(again.enabled, true);
  assert.equal(again.nextRunAt, now + 181_000);
});

test("delivery failures are recorded and can disable the task", async () => {
  const path = tempStore();
  const task = await store.createScheduledTask({ ...base, cron: "*/5 * * * *" }, Date.now(), path);
  await store.recordTaskResult(task.id, { ok: false, error: "the session no longer exists", disable: true }, path);
  const failed = store.getScheduledTask(task.id, path);
  assert.equal(failed.lastStatus, "error");
  assert.equal(failed.enabled, false);
  await store.recordTaskResult(task.id, { ok: true }, path);
  assert.equal(store.getScheduledTask(task.id, path).lastError, undefined);
});

test("a damaged store is set aside instead of wedging the scheduler", async () => {
  const path = tempStore();
  writeFileSync(path, "{ not json");
  assert.deepEqual(store.listScheduledTasks({}, path), []);
  assert.ok(readdirSync(join(path, "..")).some((name) => name.includes(".corrupt-")));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).tasks, []);
});

test("per-session cap", async () => {
  const path = tempStore();
  for (let index = 0; index < store.MAX_TASKS_PER_SESSION; index += 1) {
    await store.createScheduledTask({ ...base, name: `t${index}`, delaySeconds: 600 }, Date.now(), path);
  }
  await assert.rejects(store.createScheduledTask({ ...base, delaySeconds: 600 }, Date.now(), path), /already has/);
});

test("only one-shot tasks may steer; moving to cron drops a stored steer", async () => {
  const path = tempStore();
  const now = Date.now();
  await assert.rejects(store.createScheduledTask({ ...base, cron: "0 9 * * *", delivery: "steer" }, now, path), /always use delivery "followUp"/);
  const task = await store.createScheduledTask({ ...base, delaySeconds: 300, delivery: "steer" }, now, path);
  assert.equal(task.delivery, "steer");
  assert.equal(store.taskDelivery(task), "steer");
  const recurring = await store.updateScheduledTask(task.id, { cron: "0 9 * * *" }, { now }, path);
  assert.equal(recurring.delivery, undefined);
  assert.equal(store.taskDelivery(recurring), "followUp");
  await assert.rejects(store.updateScheduledTask(task.id, { delivery: "steer" }, { now }, path), /always use delivery/);
});
