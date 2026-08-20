import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { closeFileTab, EMPTY_FILE_PANEL, openFileTab } = await jiti.import("./file-panel-model.ts");

const opened = openFileTab(EMPTY_FILE_PANEL, "/repo/a.ts", "a.ts", { sourceSessionId: "session-1" });

test("opening a file activates and opens its tab", () => {
  assert.equal(opened.isOpen, true);
  assert.equal(opened.activeTabId, "file:/repo/a.ts");
  assert.equal(opened.tabs[0].sourceSessionId, "session-1");
});

test("opening an existing file updates metadata without duplicating the tab", () => {
  const next = openFileTab(opened, "/repo/a.ts", "a.ts", { modeHint: "diff" });
  assert.equal(next.tabs.length, 1);
  assert.equal(next.tabs[0].initialDisplayMode, "diff");
});

test("closing the active tab selects the adjacent remaining tab", () => {
  const twoTabs = openFileTab(opened, "/repo/b.ts", "b.ts");
  const next = closeFileTab(twoTabs, "file:/repo/b.ts");
  assert.equal(next.activeTabId, "file:/repo/a.ts");
  assert.equal(next.isOpen, true);
});

test("closing the last tab closes the panel", () => {
  assert.deepEqual(closeFileTab(opened, "file:/repo/a.ts"), EMPTY_FILE_PANEL);
});
