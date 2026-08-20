import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PendingPromptTracker } = await jiti.import("./pending-prompt-tracker.ts");

test("较早 prompt 先完成时仍保持繁忙", () => {
  const tracker = new PendingPromptTracker();
  const first = tracker.begin();
  const second = tracker.begin();

  tracker.finish(first);
  assert.equal(tracker.active, true);
  assert.equal(tracker.size, 1);

  tracker.finish(second);
  assert.equal(tracker.active, false);
  assert.equal(tracker.size, 0);
});

test("较晚 prompt 先完成时仍保持繁忙", () => {
  const tracker = new PendingPromptTracker();
  const first = tracker.begin();
  const second = tracker.begin();

  tracker.finish(second);
  assert.equal(tracker.active, true);
  assert.equal(tracker.size, 1);

  tracker.finish(first);
  assert.equal(tracker.active, false);
  assert.equal(tracker.size, 0);
});
