import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-bg-"));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const bg = await jiti.import("./background-commands.ts");

const wakes = [];
bg.setBackgroundCommandWakeForTests(async (input) => { wakes.push(input); });
const cwd = mkdtempSync(join(tmpdir(), "pi-web-bg-cwd-"));

async function until(predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function wakesFor(id) {
  return wakes.filter((wake) => wake.details.commandId === id);
}

test("a successful command wakes the session as a follow-up with its output", async () => {
  const started = bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "echo hello; echo world", label: "greet" });
  assert.equal(started.status, "running");
  await until(() => wakesFor(started.id).length === 1);
  const [wake] = wakesFor(started.id);
  assert.equal(wake.delivery, "followUp");
  assert.equal(wake.sessionId, "s1");
  assert.equal(wake.customType, "pi-web:background-command");
  assert.match(wake.content, /exited with code 0/);
  assert.match(wake.content, /hello\nworld/);
  assert.equal(bg.getBackgroundCommand(started.id).status, "exited");
});

test("auto delivery steers on failure; an explicit delivery wins", async () => {
  const failed = bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "echo boom >&2; exit 3" });
  await until(() => wakesFor(failed.id).length === 1);
  assert.equal(wakesFor(failed.id)[0].delivery, "steer");
  assert.match(wakesFor(failed.id)[0].content, /exited with code 3[\s\S]*boom/);

  const quiet = bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "exit 1", delivery: "followUp" });
  await until(() => wakesFor(quiet.id).length === 1);
  assert.equal(wakesFor(quiet.id)[0].delivery, "followUp");
});

test("the agent's own stop sends no wake; the user's stop does", async () => {
  const mine = bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "sleep 30" });
  bg.stopBackgroundCommand(mine.id, "agent");
  await until(() => bg.getBackgroundCommand(mine.id).status === "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(wakesFor(mine.id).length, 0);

  const theirs = bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "sleep 30" });
  bg.stopBackgroundCommand(theirs.id, "user");
  await until(() => wakesFor(theirs.id).length === 1);
  assert.match(wakesFor(theirs.id)[0].content, /stopped by the user/);
  assert.equal(wakesFor(theirs.id)[0].delivery, "followUp");
});

test("output can be read and searched; running commands cannot be dismissed", async () => {
  const command = bg.startBackgroundCommand({ sessionId: "s2", cwd, command: "printf 'a\\nneedle\\nb\\n'; sleep 30" });
  await until(() => (bg.readBackgroundCommandOutput(command.id) ?? []).includes("b"));
  assert.deepEqual(bg.readBackgroundCommandOutput(command.id, { search: "NEED" }), ["needle"]);
  assert.equal(bg.dismissBackgroundCommand(command.id), false);
  assert.deepEqual(bg.listBackgroundCommands({ sessionId: "s2" }).map((item) => item.id), [command.id]);
  bg.stopBackgroundCommand(command.id, "agent");
  await until(() => bg.getBackgroundCommand(command.id).status === "stopped");
  assert.equal(bg.dismissBackgroundCommand(command.id), true);
});

test("check-in interval and delivery are validated", () => {
  assert.throws(() => bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "true", checkInSeconds: 10 }), /at least 60/);
  assert.throws(() => bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "  " }), /required/);
  assert.throws(() => bg.startBackgroundCommand({ sessionId: "s1", cwd, command: "true", delivery: "now" }), /delivery/);
});

test("resolveDelivery", () => {
  assert.equal(bg.resolveDelivery("auto", { status: "failed" }), "steer");
  assert.equal(bg.resolveDelivery("auto", { status: "exited" }), "followUp");
  assert.equal(bg.resolveDelivery("steer", { status: "exited" }), "steer");
});
