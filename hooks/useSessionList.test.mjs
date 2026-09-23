import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useSessionList.ts", import.meta.url), "utf8");

test("首屏先请求摘要，随后请求不携带摘要版本的完整列表", () => {
  assert.match(source, /if \(summary\) params\.set\("summary", "1"\)/);
  assert.match(source, /summaryLoadedRef\.current = true;\s*directoryVersionRef\.current = null/);
  assert.match(source, /if \(summary\) queueMicrotask\(\(\) => void loadSessions\(false\)\)/);
});
