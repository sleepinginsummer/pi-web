import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const contextCommitSource = source.slice(
  source.indexOf("const commitContextSnapshot = useCallback"),
  source.indexOf("const startContextBackfill = useCallback"),
);
const switchSource = source.slice(
  source.indexOf("const handleModelChange = useCallback"),
  source.indexOf("const handleCompact = useCallback"),
);

test("existing-session model changes are optimistic and serialized", () => {
  const optimisticIndex = switchSource.indexOf("setCurrentModelOverride(target)");
  const requestIndex = switchSource.indexOf("await sendAgentCommand", optimisticIndex);

  assert.match(switchSource, /if \(!sid \|\| modelSwitchPendingRef\.current\) return/);
  assert.ok(optimisticIndex >= 0);
  assert.ok(requestIndex > optimisticIndex);
  assert.match(switchSource, /setModelSwitching\(true\)/);
  assert.match(switchSource, /setModelSwitching\(false\)/);
});

test("session reloads cannot clear an in-flight optimistic model", () => {
  assert.match(
    contextCommitSource,
    /setCurrentModelOverride\(\(current\) => modelSwitchPendingRef\.current \? current : null\)/,
  );
});

test("a completed model switch reloads canonical session state and reports failures", () => {
  assert.match(switchSource, /modelSwitchPendingRef\.current = false;\s*await loadSession\(sid\)/);
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)/);
  assert.match(switchSource, /Failed to switch model:/);
});
