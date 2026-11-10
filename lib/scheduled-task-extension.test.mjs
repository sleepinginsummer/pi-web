import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// The store resolves its file from the agent dir; keep the test's tasks out of the real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-task-ext-"));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createScheduledTaskExtension, SCHEDULED_TASK_TOOL_NAMES } = await jiti.import("./scheduled-task-extension.ts");

function load({ enabled = true, sessionId = "session-a" } = {}) {
  const tools = new Map();
  const state = { enabled, started: 0 };
  createScheduledTaskExtension({
    cwd: "/project",
    isEnabled: () => state.enabled,
    ensureScheduler: () => { state.started += 1; },
  }).factory({ registerTool: (tool) => tools.set(tool.name, tool) });
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => undefined,
      getEntries: () => [{ type: "message", message: { role: "user", content: "fix the build\nplease" } }],
    },
  };
  const call = (name, params) => tools.get(name).execute("id", params, undefined, undefined, ctx);
  return { tools, state, call };
}

test("registers nothing while switched off", () => {
  assert.equal(load({ enabled: false }).tools.size, 0);
});

test("registers the four tools and starts the scheduler", () => {
  const { tools, state } = load();
  assert.deepEqual([...tools.keys()], [...SCHEDULED_TASK_TOOL_NAMES]);
  assert.ok(state.started >= 1);
  assert.ok(tools.get("schedule_create").promptGuidelines.some((line) => /instead of sleeping/.test(line)));
});

test("create, list, update and delete stay within the calling session", async () => {
  const a = load({ sessionId: "session-a" });
  const b = load({ sessionId: "session-b" });
  const created = await a.call("schedule_create", { name: "ci", prompt: "check CI", cron: "*/10 * * * *" });
  assert.equal(created.isError, undefined);
  const id = created.content[0].text.match(/\[([0-9a-f]{8})\]/)[1];
  assert.match(created.content[0].text, /Next fires:/);

  assert.match((await a.call("schedule_list", {})).content[0].text, new RegExp(id));
  assert.match((await b.call("schedule_list", {})).content[0].text, /no scheduled tasks/);
  assert.equal((await b.call("schedule_delete", { id })).isError, true);

  const paused = await a.call("schedule_update", { id, enabled: false });
  assert.match(paused.content[0].text, /paused/);
  assert.equal((await a.call("schedule_delete", { id })).isError, undefined);
});

test("bad schedules come back as tool errors", async () => {
  const { call } = load();
  const result = await call("schedule_create", { name: "x", prompt: "y", cron: "every day" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid cron/);
});

test("tools refuse to change tasks once the switch is turned off", async () => {
  const { call, state } = load();
  state.enabled = false;
  const result = await call("schedule_create", { name: "x", prompt: "y", delay_seconds: 120 });
  assert.match(result.content[0].text, /turned off/);
});
