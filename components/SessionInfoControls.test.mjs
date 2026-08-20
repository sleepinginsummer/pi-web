import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionInfoModel, formatCompact } = await jiti.import("../lib/session-info-model.ts");
const translate = (key) => key;

const stats = {
  sessionName: "Example",
  sessionFile: "/tmp/example.jsonl",
  sessionId: "session-1",
  userMessages: 2,
  assistantMessages: 3,
  toolCalls: 4,
  toolResults: 4,
  totalMessages: 9,
  tokens: { input: 1200, output: 300, cacheRead: 50, cacheWrite: 0, total: 1550 },
  cost: 0.01234,
  contextUsage: { percent: 25, contextWindow: 200000, tokens: 50000 },
};

test("formats compact token counts", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1200), "1k");
  assert.equal(formatCompact(1_250_000), "1.3M");
});

test("derives session information rows without UI state", () => {
  const model = buildSessionInfoModel(stats, null, "en", translate);

  assert.deepEqual(model.sessionRows, [
    { label: "session.name", value: "Example", copyField: null },
    { label: "session.file", value: "/tmp/example.jsonl", copyField: "file" },
    { label: "session.id", value: "session-1", copyField: "id" },
  ]);
  assert.deepEqual(model.tokenRows.slice(-2), [
    { label: "session.cost", value: "$0.0123" },
    { label: "session.context", value: "25.0% / 200k" },
  ]);
});

test("prefers live context usage over the stats snapshot", () => {
  const model = buildSessionInfoModel(
    stats,
    { percent: 75, contextWindow: 100000, tokens: 75000 },
    "en",
    translate,
  );

  assert.deepEqual(model.tokenRows.at(-1), { label: "session.context", value: "75.0% / 100k" });
});
