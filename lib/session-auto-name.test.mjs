import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auto-name accepts work immediately and reports completion over session events", async () => {
  const source = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.match(source, /const autoNameTasks = globalRegistry\.__piAutoNameTasks \?\?= new Map\(\)/);
  assert.match(source, /return NextResponse\.json\(\{ status: "accepted" \}, \{ status: 202 \}\)/);
  assert.match(source, /return NextResponse\.json\(\{ status: "running" \}, \{ status: 202 \}\)/);
  assert.match(source, /type: "session_title_updated"/);
  assert.match(source, /type: "session_title_error"/);
  assert.match(source, /autoNameTasks\.delete\(sessionId\)/);
});

test("auto-name aborts title generation when the main session starts running", async () => {
  const source = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  // 订阅主会话事件：agent_start 时中止标题生成
  assert.match(source, /session\.onEvent\(\(event\) => \{/);
  assert.match(source, /event\.type === "agent_start"\) abortController\.abort\(\)/);
  // 把信号传给标题生成，避免并行复用 transport
  assert.match(source, /generateSessionTitle\([\s\S]*?abortController\.signal/);
  // 主动让路不算错误：广播 skipped 事件而不是 error
  assert.match(source, /type: "session_title_skipped"/);
  assert.match(source, /unsubscribe\(\);/);
});
