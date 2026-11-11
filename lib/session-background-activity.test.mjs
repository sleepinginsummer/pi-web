import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-activity-"));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const bg = await jiti.import("./background-commands.ts");
const tasks = await jiti.import("./scheduled-tasks.ts");
const settings = await jiti.import("./scheduled-task-settings.ts");
const { listSessionBackgroundActivity } = await jiti.import("./session-background-activity.ts");

bg.setBackgroundCommandWakeForTests(async () => {});
const cwd = mkdtempSync(join(tmpdir(), "pi-web-activity-cwd-"));
const byId = () => new Map(listSessionBackgroundActivity().map((entry) => [entry.sessionId, entry]));

async function until(predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("按会话统计运行中的后台命令，结束后不再计入", async () => {
  const first = bg.startBackgroundCommand({ sessionId: "cmd", cwd, command: "sleep 30" });
  const second = bg.startBackgroundCommand({ sessionId: "cmd", cwd, command: "sleep 30" });
  bg.startBackgroundCommand({ sessionId: "done", cwd, command: "exit 0" });
  await until(() => bg.getBackgroundCommand(bg.listBackgroundCommands({ sessionId: "done" })[0].id)?.status === "exited");
  const activity = byId();
  assert.deepEqual(activity.get("cmd"), { sessionId: "cmd", commands: 2, nextTaskAt: null });
  assert.equal(activity.has("done"), false);
  bg.stopBackgroundCommand(first.id, "agent");
  bg.stopBackgroundCommand(second.id, "agent");
  await until(() => !byId().has("cmd"));
});

test("每个会话取最早的待触发时间，暂停的任务和关闭开关后不显示", async () => {
  const now = Date.now();
  await tasks.createScheduledTask({ sessionId: "timer", cwd, name: "late", prompt: "p", delaySeconds: 7200 }, now);
  const early = await tasks.createScheduledTask({ sessionId: "timer", cwd, name: "early", prompt: "p", delaySeconds: 600 }, now);
  const paused = await tasks.createScheduledTask({ sessionId: "paused", cwd, name: "x", prompt: "p", delaySeconds: 600 }, now);
  await tasks.updateScheduledTask(paused.id, { enabled: false });
  const activity = byId();
  assert.equal(activity.get("timer")?.nextTaskAt, early.nextRunAt);
  assert.equal(activity.get("timer")?.commands, 0);
  assert.equal(activity.has("paused"), false);

  settings.writeScheduledTasksEnabled(false);
  assert.equal(byId().has("timer"), false);
  settings.writeScheduledTasksEnabled(true);
  assert.ok(JSON.parse(readFileSync(tasks.getScheduledTasksPath(), "utf8")).tasks.length >= 3);
  assert.equal(byId().get("timer")?.nextTaskAt, early.nextRunAt);
});
