import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const globalAttentionHookSource = await readFile(new URL("../hooks/useGlobalAttentionNotifications.ts", import.meta.url), "utf8");

test("attention notifications have one AppShell-level source", () => {
  assert.doesNotMatch(source, /useAttentionNotifications/);
  assert.match(appShellSource, /useGlobalAttentionNotifications\(\{/);
  assert.match(globalAttentionHookSource, /new EventSource\("\/api\/agent\/attention\/events"\)/);
  assert.equal((appShellSource.match(/useGlobalAttentionNotifications\(\{/g) ?? []).length, 1);
});

test("tips use the compact left-side shelf and reveal full text on hover", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(source, /className="notice-shelf-overlay"/);
  assert.match(source, /className="notice-shelf-message"/);
  assert.match(styles, /\.notice-shelf-item\s*\{[\s\S]*?width: min\(240px, 100%\);[\s\S]*?min-height: 34px/);
  assert.match(styles, /\.notice-shelf-item:hover \.notice-shelf-message[\s\S]*?white-space: normal/);
});
