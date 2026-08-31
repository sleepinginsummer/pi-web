import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { stabilizeStringSet } = await jiti.import("./stable-string-set.ts");

test("reuses the current Set reference when ids are unchanged", () => {
  const current = new Set(["session-a", "session-b"]);
  const next = stabilizeStringSet(current, ["session-b", "session-a", "session-a"]);
  assert.strictEqual(next, current);
});

test("returns a new Set reference when ids change", () => {
  const current = new Set(["session-a"]);
  const added = stabilizeStringSet(current, ["session-a", "session-b"]);
  const replaced = stabilizeStringSet(current, ["session-b"]);

  assert.notStrictEqual(added, current);
  assert.deepEqual([...added], ["session-a", "session-b"]);
  assert.notStrictEqual(replaced, current);
  assert.deepEqual([...replaced], ["session-b"]);
});
