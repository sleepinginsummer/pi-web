import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useCompletionEffects.ts", import.meta.url), "utf8");

test("声音、带目录名的系统通知和上层回调订阅同一个 completion", () => {
  assert.match(source, /handledRunIdRef\.current === completion\.runId/);
  assert.match(source, /if \(soundEnabled\) playDoneSound\(\)/);
  assert.match(source, /notifySession\(title, body, completion\.sessionId, \{ folderName, showWhenActive: true \}\)/);
  assert.match(source, /onComplete\?\.\(\)/);
});
