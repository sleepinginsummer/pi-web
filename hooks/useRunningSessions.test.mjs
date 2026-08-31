import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useRunningSessions.ts", import.meta.url), "utf8");

test("commits running snapshots through the stable Set helper", () => {
  assert.match(source, /import \{ stabilizeStringSet \} from "@\/lib\/stable-string-set"/);
  assert.match(source, /setRunningSessionIds\(\(current\) => stabilizeStringSet\(current, ids\)\)/);
});

test("pauses polling while the document is hidden", () => {
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(source, /controller\?\.abort\(\)/);
});
