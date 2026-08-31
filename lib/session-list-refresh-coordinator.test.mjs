import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_TRACKED_SESSION_REFRESHES,
  NEW_SESSION_SETTLED_REFRESH_DELAY_MS,
  SessionListRefreshCoordinator,
} = await jiti.import("./session-list-refresh-coordinator.ts");

function createHarness() {
  let nextHandle = 1;
  const timers = new Map();
  let refreshes = 0;
  const coordinator = new SessionListRefreshCoordinator(
    () => { refreshes += 1; },
    {
      set(callback, delayMs) {
        const handle = nextHandle++;
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      clear(handle) { timers.delete(handle); },
    },
  );
  return {
    coordinator,
    refreshes: () => refreshes,
    pending: () => [...timers.values()],
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(({ callback }) => callback());
    },
  };
}

test("merges a new-session settled refresh into a following title refresh", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "new-session-persisted", sessionId: "new-1" });
  state.coordinator.request({ reason: "run-settled", sessionId: "new-1" });

  assert.equal(state.refreshes(), 1);
  assert.equal(state.pending().length, 1);
  assert.equal(state.pending()[0].delayMs, NEW_SESSION_SETTLED_REFRESH_DELAY_MS);

  state.coordinator.request({ reason: "title-generated", sessionId: "new-1" });
  state.runTimers();
  assert.equal(state.refreshes(), 2);
});

test("does not refresh settled again when title arrived first", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "new-session-persisted", sessionId: "new-1" });
  state.coordinator.request({ reason: "title-generated", sessionId: "new-1" });
  state.coordinator.request({ reason: "run-settled", sessionId: "new-1" });

  assert.equal(state.refreshes(), 2);
  assert.equal(state.pending().length, 0);
});

test("publishes a trailing settled refresh when no title arrives", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "new-session-persisted", sessionId: "new-1" });
  state.coordinator.request({ reason: "run-settled", sessionId: "new-1" });
  state.runTimers();

  assert.equal(state.refreshes(), 2);
});

test("does not persist component-local run identity across remounts", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "run-settled", sessionId: "existing-1" });
  state.coordinator.request({ reason: "run-settled", sessionId: "existing-1" });

  // settleRun owns per-mount dedupe; AppShell must not suppress a later mount's run.
  assert.equal(state.refreshes(), 2);
});

test("deduplicates title events and bounds historical title state", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "title-generated", sessionId: "title-0" });
  state.coordinator.request({ reason: "title-generated", sessionId: "title-0" });
  assert.equal(state.refreshes(), 1);

  for (let index = 1; index <= MAX_TRACKED_SESSION_REFRESHES; index += 1) {
    state.coordinator.request({ reason: "title-generated", sessionId: `title-${index}` });
  }
  assert.equal(state.refreshes(), MAX_TRACKED_SESSION_REFRESHES + 1);

  // title-0 已被 LRU 淘汰，再次到达时允许刷新并重新进入有界集合。
  state.coordinator.request({ reason: "title-generated", sessionId: "title-0" });
  assert.equal(state.refreshes(), MAX_TRACKED_SESSION_REFRESHES + 2);
});

test("dispose cancels a pending trailing refresh", () => {
  const state = createHarness();
  state.coordinator.request({ reason: "new-session-persisted", sessionId: "new-1" });
  state.coordinator.request({ reason: "run-settled", sessionId: "new-1" });
  state.coordinator.dispose();
  state.runTimers();

  assert.equal(state.refreshes(), 1);
});
