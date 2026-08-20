import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auto-name accepts work immediately and reports completion over session events", async () => {
  const source = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.match(source, /void runAutoNameTask\(id, filePath, session, operationId\)/);
  assert.match(source, /return NextResponse\.json\(\{ status: "accepted", operationId \}, \{ status: 202 \}\)/);
  assert.match(source, /isValidSessionTitleOperationId\(body\?\.operationId\)/);
  assert.match(source, /type: "session_title_updated"[\s\S]*?operationId/);
  assert.match(source, /type: "session_title_error"[\s\S]*?operationId/);
  assert.doesNotMatch(source, /autoNameTasks|__piAutoNameTasks/);
});

test("auto-name uses an independent file-level generator while the main session is running", async () => {
  const routeSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");
  const serviceSource = await readFile(new URL("./session-file-title.ts", import.meta.url), "utf8");

  // 手动命名显式覆盖已有标题，并统一委托独立 services/transport 的文件级生成器。
  assert.match(routeSource, /generateTitleForSessionFile\(filePath, \{ overwrite: true \}\)/);
  assert.doesNotMatch(routeSource, /session\.isRunning\(\)/);
  assert.doesNotMatch(routeSource, /generateSessionTitle\(/);
  // 自动命名、回收站和批处理不传 overwrite，仍跳过已有标题。
  assert.match(serviceSource, /if \(!task\.overwrite && sessionManager\.getSessionName\(\)\) return null/);
  assert.match(serviceSource, /return result\.title/);
});

test("file-level title service delegates scheduling and preserves write CAS", async () => {
  const source = await readFile(new URL("./session-file-title.ts", import.meta.url), "utf8");
  const restoreSource = await readFile(new URL("../app/api/trash/[name]/route.ts", import.meta.url), "utf8");

  assert.match(source, /sessionTitleCoordinator\.submit\(filePath, options\.overwrite === true\)/);
  assert.match(source, /writer = SessionManager\.open\(task\.target\.filePath\)/);
  assert.match(source, /const initialName = sessionManager\.getSessionName\(\)/);
  assert.match(source, /writer\.getSessionId\(\) !== task\.sessionId \|\| writer\.getSessionName\(\) !== initialName/);
  assert.match(restoreSource, /updateSessionTitleTaskPath\(sessionId, restoredPath\)/);
});
