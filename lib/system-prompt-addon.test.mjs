import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SYSTEM_PROMPT_ADDON_MAX_LENGTH,
  appendSystemPromptAddon,
  ensureSessionSystemPromptAddon,
  isSystemPromptAddonExtension,
  readDefaultSystemPromptAddonText,
  updateSessionSystemPromptAddon,
  viewSessionSystemPromptAddon,
  withSessionSystemPromptAddon,
  writeDefaultSystemPromptAddonText,
} = await jiti.import("./system-prompt-addon.ts");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-addon-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a session is off by default and previews the default text without a snapshot", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: false, text: "" });
  writeDefaultSystemPromptAddonText("one", dir);
  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: false, text: "one" });
  writeDefaultSystemPromptAddonText("two", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "two");
});

test("a started session keeps its copy when the default changes", (t) => {
  const dir = tempDir(t);
  writeDefaultSystemPromptAddonText("original", dir);
  ensureSessionSystemPromptAddon("a", dir);
  writeDefaultSystemPromptAddonText("changed", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "original");
  ensureSessionSystemPromptAddon("b", dir);
  assert.equal(viewSessionSystemPromptAddon("b", dir).text, "changed");
});

test("started sessions stay isolated while the latest edit becomes the default", (t) => {
  const dir = tempDir(t);
  writeDefaultSystemPromptAddonText("default", dir);
  updateSessionSystemPromptAddon("a", { enabled: true, text: "for a" }, dir);
  assert.equal(readDefaultSystemPromptAddonText(dir), "for a");
  updateSessionSystemPromptAddon("b", { text: "for b" }, dir);

  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: true, text: "for a" });
  assert.deepEqual(viewSessionSystemPromptAddon("b", dir), { enabled: false, text: "for b" });
  assert.equal(readDefaultSystemPromptAddonText(dir), "for b");
  assert.equal(viewSessionSystemPromptAddon("new", dir).text, "for b");
});

test("clearing, re-saving unchanged text or toggling leaves the default alone", (t) => {
  const dir = tempDir(t);
  updateSessionSystemPromptAddon("a", { text: "old" }, dir);
  writeDefaultSystemPromptAddonText("newer", dir);

  updateSessionSystemPromptAddon("a", { text: "old" }, dir);
  updateSessionSystemPromptAddon("a", { enabled: true }, dir);
  updateSessionSystemPromptAddon("a", { text: "  " }, dir);

  assert.equal(readDefaultSystemPromptAddonText(dir), "newer");
});

test("a partial session update keeps the other field", (t) => {
  const dir = tempDir(t);
  updateSessionSystemPromptAddon("a", { text: "kept" }, dir);
  assert.deepEqual(updateSessionSystemPromptAddon("a", { enabled: true }, dir), { enabled: true, text: "kept" });
});

test("rejects oversized text and session ids that would escape the directory", (t) => {
  const dir = tempDir(t);
  const oversized = "x".repeat(SYSTEM_PROMPT_ADDON_MAX_LENGTH + 1);
  assert.throws(() => writeDefaultSystemPromptAddonText(oversized, dir), RangeError);
  assert.throws(() => updateSessionSystemPromptAddon("a", { text: oversized }, dir), RangeError);
  assert.throws(() => updateSessionSystemPromptAddon("../evil", { enabled: true }, dir), RangeError);
});

test("a damaged default reads as empty", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pi-web-system-prompt-addon.json"), "{broken");
  assert.equal(readDefaultSystemPromptAddonText(dir), "");
});

test("appends only when enabled and non-blank", () => {
  assert.equal(appendSystemPromptAddon("Base\n", { enabled: true, text: " Extra\n" }), "Base\n\nExtra");
  assert.equal(appendSystemPromptAddon(" ", { enabled: true, text: "Extra" }), "Extra");
  assert.equal(appendSystemPromptAddon("Base", { enabled: false, text: "Extra" }), undefined);
  assert.equal(appendSystemPromptAddon("Base", { enabled: true, text: "  \n" }), undefined);
});

test("recognizes the extension by its install path", () => {
  assert.equal(isSystemPromptAddonExtension({ path: "/x/git/github.com/sleepinginsummer/pi-system-prompt-addon/index.ts" }), true);
  assert.equal(isSystemPromptAddonExtension({ path: "/x/pi-shadow-mind/index.ts" }), false);
  assert.equal(isSystemPromptAddonExtension({}), false);
});

test("a staged new-session switch is written to the real session before the id is returned, and only once", async (t) => {
  const client = await jiti.import("./system-prompt-addon-client.ts");
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ enabled: true, text: "" }), { status: 200 });
  };

  await client.commitStagedSystemPromptAddon("/not-staged", "s0");
  assert.deepEqual(calls, []);

  client.setSystemPromptAddonStaged("/cwd", true);
  await client.commitStagedSystemPromptAddon("/cwd", "s1");
  await client.commitStagedSystemPromptAddon("/cwd", "s1");
  assert.deepEqual(calls, [{ sessionId: "s1", enabled: true }]);
  assert.equal(client.isSystemPromptAddonStaged("/cwd"), false);
});

test("the panel text matches the request and viewing creates no snapshot", (t) => {
  const dir = tempDir(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  writeDefaultSystemPromptAddonText("first", dir);
  assert.equal(withSessionSystemPromptAddon("Base", "a"), "Base");
  writeDefaultSystemPromptAddonText("second", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "second");

  updateSessionSystemPromptAddon("a", { enabled: true }, dir);
  assert.equal(withSessionSystemPromptAddon("Base", "a"), "Base\n\nsecond");
  assert.equal(withSessionSystemPromptAddon("Base", "../bad"), "Base");
});
