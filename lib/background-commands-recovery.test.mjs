import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-bg-recovery-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const bg = await jiti.import("./background-commands.ts");

const snapshot = (id, status) => ({
  id, sessionId: "s1", cwd: "/p", command: `run ${id}`, status, startedAt: Date.now() - 90_000, delivery: "auto", checkIns: 0,
});

test("commands running when pi-web stopped come back as interrupted and wake their sessions", async () => {
  writeFileSync(bg.getBackgroundCommandStorePath(), JSON.stringify({
    version: 1,
    commands: [snapshot("aaaa0001", "running"), snapshot("aaaa0002", "exited")],
  }));
  const wakes = [];
  bg.setBackgroundCommandWakeForTests(async (input) => { wakes.push(input); });

  assert.equal(bg.recoverBackgroundCommands(), 2);
  for (let i = 0; i < 50 && wakes.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bg.getBackgroundCommand("aaaa0001").status, "interrupted");
  assert.equal(bg.getBackgroundCommand("aaaa0002").status, "exited");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].sessionId, "s1");
  assert.equal(wakes[0].delivery, "followUp");
  assert.match(wakes[0].content, /interrupted by a pi-web restart[\s\S]*Run it again/);

  // The new state is saved, so a second restart does not report it again.
  const stored = JSON.parse(readFileSync(bg.getBackgroundCommandStorePath(), "utf8")).commands;
  assert.equal(stored.find((item) => item.id === "aaaa0001").status, "interrupted");
});

test("started and dismissed commands are saved to the list", async () => {
  bg.setBackgroundCommandWakeForTests(async () => {});
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-bg-recovery-cwd-"));
  const started = bg.startBackgroundCommand({ sessionId: "s2", cwd, command: "true" });
  const read = () => JSON.parse(readFileSync(bg.getBackgroundCommandStorePath(), "utf8")).commands.map((item) => item.id);
  assert.ok(read().includes(started.id));
  for (let i = 0; i < 200 && bg.getBackgroundCommand(started.id).status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(bg.dismissBackgroundCommand(started.id), true);
  assert.ok(!read().includes(started.id));
});
