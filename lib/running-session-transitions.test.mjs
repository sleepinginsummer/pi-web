import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { diffRunningSessions } = await jiti.import("./running-session-transitions.ts");

test("identifies started and background-completed sessions", () => {
  const result = diffRunningSessions(
    new Set(["completed", "still-running"]),
    new Set(["still-running", "started"]),
    "selected",
  );

  assert.deepEqual(result, {
    completedInBackground: ["completed"],
    started: ["started"],
  });
});

test("excludes the selected session from background completion", () => {
  const result = diffRunningSessions(new Set(["selected"]), new Set(), "selected");
  assert.deepEqual(result.completedInBackground, []);
});
