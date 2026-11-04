import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { NOTICE_VISIBLE_MS, noticeReducer } = await jiti.import("./notice-state.ts");

const shown = (overrides = {}) => ({ id: "a", message: "m", type: "info", shownAt: 0, ...overrides });
const state = (...visible) => ({ visible, pending: [] });

test("notices stay visible for five seconds", () => {
  assert.equal(NOTICE_VISIBLE_MS, 5_000);
});

test("an expanded notice never expires, however long it stays open", () => {
  const next = noticeReducer(state(shown({ expanded: true })), { type: "mark_expired", now: NOTICE_VISIBLE_MS * 100 });
  assert.equal(next.visible[0].exiting, undefined);
});

test("a collapsed notice expires as before", () => {
  const next = noticeReducer(state(shown()), { type: "mark_expired", now: NOTICE_VISIBLE_MS });
  assert.equal(next.visible[0].exiting, true);
});

test("collapsing restarts the full visible time", () => {
  const collapsed = noticeReducer(state(shown({ expanded: true })), { type: "set_expanded", id: "a", expanded: false, now: 60_000 });
  const early = noticeReducer(collapsed, { type: "mark_expired", now: 60_000 + NOTICE_VISIBLE_MS - 1 });
  assert.notEqual(early.visible[0].exiting, true);
  const late = noticeReducer(collapsed, { type: "mark_expired", now: 60_000 + NOTICE_VISIBLE_MS });
  assert.equal(late.visible[0].exiting, true);
});

test("expanding during the exit animation keeps the notice", () => {
  const next = noticeReducer(state(shown({ exiting: true })), { type: "set_expanded", id: "a", expanded: true, now: 1 });
  assert.equal(next.visible[0].exiting, false);
  assert.equal(next.visible[0].expanded, true);
});

test("expanding only touches the clicked notice", () => {
  const next = noticeReducer(state(shown(), shown({ id: "b" })), { type: "set_expanded", id: "a", expanded: true, now: 1 });
  assert.equal(next.visible[1].expanded, undefined);
});
