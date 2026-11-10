import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-bg-ext-"));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createBackgroundCommandExtension, BACKGROUND_COMMAND_TOOL_NAMES } = await jiti.import("./background-command-extension.ts");
const bg = await jiti.import("./background-commands.ts");
bg.setBackgroundCommandWakeForTests(async () => {});

function load({ enabled = true, activeTools = ["bash"], sessionId = "a" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-bg-ext-cwd-"));
  const tools = new Map();
  const state = { enabled, activeTools };
  createBackgroundCommandExtension({ cwd, isEnabled: () => state.enabled }).factory({
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => state.activeTools,
  });
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const call = (name, params) => tools.get(name).execute("id", params, undefined, undefined, ctx);
  return { tools, state, call };
}

test("registers nothing while switched off", () => {
  assert.equal(load({ enabled: false }).tools.size, 0);
});

test("registers the three tools with guidance against polling", () => {
  const { tools } = load();
  assert.deepEqual([...tools.keys()], [...BACKGROUND_COMMAND_TOOL_NAMES]);
  assert.ok(tools.get("bash_background").promptGuidelines.some((line) => /Do not poll/.test(line)));
});

test("starting follows the bash tool", async () => {
  const { call, state } = load({ activeTools: ["read"] });
  const blocked = await call("bash_background", { command: "true" });
  assert.match(blocked.content[0].text, /need the bash tool/);
  state.activeTools = ["bash"];
  const started = await call("bash_background", { command: "sleep 30", label: "nap" });
  assert.match(started.content[0].text, /Started in the background: \[[0-9a-f]{8}\] "nap"/);
  const id = started.content[0].text.match(/\[([0-9a-f]{8})\]/)[1];
  assert.match((await call("bash_background_output", {})).content[0].text, /nap/);
  assert.match((await call("bash_background_stop", { id })).content[0].text, /Stopping/);
});

test("a session cannot read or stop another session's command", async () => {
  const a = load({ sessionId: "a" });
  const b = load({ sessionId: "b" });
  const started = await a.call("bash_background", { command: "sleep 30" });
  const id = started.content[0].text.match(/\[([0-9a-f]{8})\]/)[1];
  assert.equal((await b.call("bash_background_output", { id })).isError, true);
  assert.equal((await b.call("bash_background_stop", { id })).isError, true);
  await a.call("bash_background_stop", { id });
});
