import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useChatScrollFollow.ts", import.meta.url), "utf8");

test("流式滚动由尺寸监听统一限频且跳过无位移写入", () => {
  assert.match(source, /const STREAMING_SCROLL_INTERVAL_MS = 50/);
  assert.match(source, /new ResizeObserver\(scheduleSync\)/);
  assert.match(source, /Math\.abs\(container\.scrollTop - targetTop\) < 1/);
  assert.match(source, /container\.scrollTo\(\{\s*top: targetTop,/);
  assert.doesNotMatch(source, /scrollIntoView/);
  assert.doesNotMatch(source, /\[agentRunning,[\s\S]*?streamingContent/);
});

test("会话结束定位在最终布局后精确滚到底部", () => {
  assert.match(source, /positionRequest\.position === "running-end"[\s\S]*?isFollowingRef\.current[\s\S]*?scrollToLatest\("instant"\)/);
  assert.doesNotMatch(source, /previousAgentRunningRef|wasRunning/);
});
