import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useChatScrollFollow.ts", import.meta.url), "utf8");

test("流式滚动由尺寸监听统一限频且跳过无位移写入", () => {
  assert.match(source, /const STREAMING_SCROLL_INTERVAL_MS = 50/);
  assert.match(source, /new ResizeObserver\(scheduleSync\)/);
  assert.match(source, /Math\.abs\(container\.scrollTop - targetTop\) < 1/);
  assert.doesNotMatch(source, /\[agentRunning,[\s\S]*?streamingContent/);
});
