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
