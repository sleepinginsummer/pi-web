import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  getSessionContentIndex,
  readIndexedContextPage,
  readIndexedSessionDetails,
  resetSessionContentIndexesForTests,
} = await jiti.import("./session-content-index.ts");

const line = (value) => `${JSON.stringify(value)}\n`;

test("持久化索引按祖先分页，并在追加和进程缓存重置后保持正确", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-content-index-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const filePath = join(root, "session.jsonl");
  const rows = [line({ type: "session", version: 3, id: "indexed", cwd: root, timestamp: "2026-01-01T00:00:00.000Z" })];
  let parentId = null;
  for (let index = 0; index < 80; index += 1) {
    const id = `e${index}`;
    rows.push(line({
      type: "message",
      id,
      parentId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      message: { role: "user", content: `message ${index}`, timestamp: index + 1 },
    }));
    parentId = id;
  }
  await writeFile(filePath, rows.join(""));
  t.after(async () => {
    resetSessionContentIndexesForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const first = await readIndexedContextPage(filePath, { tail: 10 });
  assert.deepEqual(first.entries.map((entry) => entry.id), Array.from({ length: 10 }, (_, i) => `e${70 + i}`));
  assert.equal(first.leafId, "e79");
  const older = await readIndexedContextPage(filePath, { before: "e70", tail: 10 });
  assert.deepEqual(older.entries.map((entry) => entry.id), Array.from({ length: 10 }, (_, i) => `e${60 + i}`));

  const beforeAppendVersion = first.version;
  await appendFile(filePath, '{"type":"message","id":"partial"');
  const partial = await getSessionContentIndex(filePath);
  assert.equal(partial.leafId, "e79");
  await appendFile(filePath, ',"parentId":"e79","timestamp":"2026-01-01T00:02:00.000Z","message":{"role":"assistant","content":"done"}}\n');
  const appended = await readIndexedContextPage(filePath, { tail: 1 });
  assert.equal(appended.entries.at(-1).id, "partial");
  assert.notEqual(appended.version, beforeAppendVersion);

  resetSessionContentIndexesForTests();
  const restored = await readIndexedContextPage(filePath, { tail: 1 });
  assert.equal(restored.entries.at(-1).id, "partial");
  assert.equal(restored.version, appended.version);
  const details = await readIndexedSessionDetails(filePath);
  assert.equal(details.leafId, "partial");
  assert.ok(details.tree.length > 0);
});

test("分支设置、详情版本和整文件重写保持一致", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-content-branch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const filePath = join(root, "branch.jsonl");
  t.after(async () => {
    resetSessionContentIndexesForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(filePath, [
    { type: "session", version: 3, id: "branch", cwd: root, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "openai", modelId: "gpt-test" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: "2026-01-01T00:00:02.000Z", thinkingLevel: "high" },
    { type: "message", id: "user", parentId: "thinking", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "question" } },
    { type: "message", id: "left", parentId: "user", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "left" }] } },
    { type: "message", id: "right", parentId: "user", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "right" }] } },
  ].map(line).join(""));

  const page = await readIndexedContextPage(filePath, { leafId: "left", tail: 20 });
  assert.deepEqual(page.entries.map((entry) => entry.id), ["model", "thinking", "user", "left"]);
  assert.deepEqual(page.settings, { thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } });
  const details = await readIndexedSessionDetails(filePath);
  assert.equal(details.version, page.version);
  assert.equal(details.leafId, "right");

  await writeFile(filePath, [
    line({ type: "session", version: 3, id: "branch", cwd: root, timestamp: "2026-01-01T00:00:00.000Z" }),
    line({ type: "message", id: "replacement", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "rewritten" } }),
  ].join(""));
  const rewritten = await readIndexedContextPage(filePath, { tail: 20 });
  assert.deepEqual(rewritten.entries.map((entry) => entry.id), ["replacement"]);
  assert.notEqual(rewritten.version, page.version);
});
