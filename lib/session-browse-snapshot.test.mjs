import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  readSessionBrowseSnapshot,
  resetSessionBrowseCacheForTests,
} = await jiti.import("./session-browse-snapshot.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

test("同一文件版本复用只读快照，文件变化后生成新版本", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-browse-cache-"));
  const sessionId = `browse-${Date.now()}`;
  const filePath = join(root, `${sessionId}.jsonl`);
  await writeFile(filePath, [
    line({ type: "session", version: 3, id: sessionId, cwd: root, timestamp: "2026-01-01T00:00:00.000Z" }),
    line({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } }),
  ].join(""));
  cacheSessionPath(sessionId, filePath);
  resetSessionBrowseCacheForTests();
  t.after(async () => {
    resetSessionBrowseCacheForTests();
    invalidateSessionPathCache(sessionId);
    await rm(root, { recursive: true, force: true });
  });

  const first = await readSessionBrowseSnapshot(sessionId);
  const second = await readSessionBrowseSnapshot(sessionId);
  assert.equal(first?.cacheStatus, "miss");
  assert.equal(second?.cacheStatus, "hit");
  assert.equal(second?.version, first?.version);

  await appendFile(filePath, line({
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
  }));
  const changed = await readSessionBrowseSnapshot(sessionId);
  assert.equal(changed?.cacheStatus, "miss");
  assert.notEqual(changed?.version, first?.version);
  assert.equal(changed?.entries.length, 2);
});
