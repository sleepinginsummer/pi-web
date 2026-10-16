import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useCompletionEffects.ts", import.meta.url), "utf8");

test("声音、带目录名的系统通知和上层回调订阅同一个 completion", () => {
  assert.match(source, /handledRunIdRef\.current === completion\.runId/);
  assert.match(source, /if \(soundEnabled\) playDoneSound\(\)/);
  assert.match(source, /isManualStopNotificationSuppressed\(completion\.sessionId\)/);
  assert.match(source, /if \(!notificationSuppressed\)[\s\S]*?notifySession\(title, body, completion\.sessionId, \{ folderName, showWhenActive: true \}\)/);
  assert.match(source, /onComplete\?\.\(\)/);
});

test("被停止的运行不播放提示音也不发通知，但仍通知上层", () => {
  assert.match(source, /if \(completion\.aborted\) \{\s*onComplete\?\.\(\);\s*return;\s*\}[\s\S]*?if \(soundEnabled\) playDoneSound\(\)/);
});
