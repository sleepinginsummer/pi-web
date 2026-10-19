import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createDevServerExtension, DEV_SERVER_TOOL_NAMES } = await jiti.import("./dev-server-extension.ts");

function load({ enabled = true, activeTools = ["bash"] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-dev-ext-"));
  const tools = new Map();
  const state = { enabled, activeTools };
  const extension = createDevServerExtension({ cwd, isEnabled: () => state.enabled });
  extension.factory({
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => state.activeTools,
  });
  return { tools, state, cwd };
}

test("registers nothing while switched off", () => {
  assert.equal(load({ enabled: false }).tools.size, 0);
});

test("registers the four tools with guidance that points at the launch file", () => {
  const { tools } = load();
  assert.deepEqual([...tools.keys()], [...DEV_SERVER_TOOL_NAMES]);
  const start = tools.get("server_start");
  assert.match(start.description, /\.pi\/launch\.json/);
  assert.ok(start.promptGuidelines.some((line) => /never with bash/.test(line)));
});

test("start and stop follow the bash tool and the switch at call time", async () => {
  const { tools, state } = load({ activeTools: ["read"] });
  const blocked = await tools.get("server_start").execute("1", { name: "web" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /needs the bash tool/);

  state.activeTools = ["bash"];
  const missing = await tools.get("server_start").execute("2", { name: "web" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No server named "web"[\s\S]*"configurations"/);

  state.enabled = false;
  const off = await tools.get("server_stop").execute("3", { id: "x" });
  assert.match(off.content[0].text, /turned off/);

  const listed = await tools.get("server_list").execute("4", {});
  assert.match(listed.content[0].text, /No servers have been started/);
});
