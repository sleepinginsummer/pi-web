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


test("相同 ID 和详情不追加、不重置可见时间或用户展开状态", () => {
  const current = state(shown({ id: "retry", type: "error", expanded: true }));
  const next = noticeReducer(current, { type: "add", notice: { id: "retry", type: "error", message: "m", expanded: false }, now: 4000 });
  assert.equal(next, current);
  assert.equal(next.visible[0].shownAt, 0);
});

test("相同 ID 的详情变化原位更新，保留展开状态并结束退场", () => {
  const current = state(shown({ id: "first" }), shown({ id: "retry", type: "error", expanded: true, exiting: true }), shown({ id: "last" }));
  const next = noticeReducer(current, { type: "add", notice: { id: "retry", type: "error", message: "最新原因", expanded: false }, now: 6000 });
  assert.deepEqual(next.visible.map(notice => notice.id), ["first", "retry", "last"]);
  assert.equal(next.visible[1].message, "最新原因");
  assert.equal(next.visible[1].expanded, true);
  assert.equal(next.visible[1].exiting, false);
  assert.equal(next.visible[1].shownAt, 6000);
  assert.equal(next.visible[0], current.visible[0]);
  assert.equal(next.visible[2], current.visible[2]);
});

test("可见通知全部展开时，更新待显示通知保留位置且不会追加副本", () => {
  const current = { visible: Array.from({ length: 5 }, (_, index) => shown({ id: `v-${index}`, expanded: true })),
    pending: [{ id: "retry", message: "原原因", type: "error" }, { id: "other", message: "其它通知", type: "info" }] };
  let next = current;
  for (let index = 0; index < 50; index++) next = noticeReducer(next, { type: "add", notice: { id: "retry", message: `原因 ${index}`, type: "error" }, now: index });
  assert.deepEqual(next.pending.map(notice => notice.id), ["retry", "other"]);
  assert.equal(next.pending[0].message, "原因 49");
  assert.equal(next.pending[0].shownAt, undefined);
  assert.equal(next.visible, current.visible);
  assert.equal(next.pending[1], current.pending[1]);
  const shownNext = noticeReducer(next, { type: "remove", id: "v-0", now: 100 });
  assert.equal(shownNext.visible.at(-1).message, "原因 49");
  assert.equal(shownNext.visible.at(-1).shownAt, 100);
});


test("新详情更新后，旧退场删除不能移除它或提前补入待显示项", () => {
  const exiting = shown({ exiting: true });
  const current = { visible: [exiting, ...Array.from({ length: 4 }, (_, index) => shown({ id: `v-${index}`, expanded: true }))],
    pending: [{ id: "waiting", message: "排队提示", type: "info" }] };
  const updated = noticeReducer(current, { type: "add", notice: { id: "a", message: "新详情", type: "error" }, now: 5100 });
  const next = noticeReducer(updated, { type: "remove", id: "a", expectedExit: exiting, now: 5180 });
  assert.equal(next, updated);
  assert.equal(next.visible[0].message, "新详情");
  assert.equal(next.pending.length, 1);
});

test("通知更新后再次进入退场，仍不能被上一次退场删除", () => {
  const oldExit = shown({ exiting: true });
  const updated = noticeReducer(state(oldExit), { type: "add", notice: { id: "a", message: "新详情", type: "info" }, now: 100 });
  const exitingAgain = noticeReducer(updated, { type: "mark_expired", now: 5100 });
  assert.equal(exitingAgain.visible[0].exiting, true);
  assert.equal(noticeReducer(exitingAgain, { type: "remove", id: "a", expectedExit: oldExit, now: 5200 }), exitingAgain);
});

test("退场期间展开后，旧删除动作失效", () => {
  const exiting = shown({ exiting: true });
  const expanded = noticeReducer(state(exiting), { type: "set_expanded", id: "a", expanded: true, now: 5100 });
  assert.equal(noticeReducer(expanded, { type: "remove", id: "a", expectedExit: exiting, now: 5180 }), expanded);
});

test("当前退场项的删除正常移除并按顺序补入待显示项", () => {
  const exiting = shown({ exiting: true });
  const current = { visible: [exiting, ...Array.from({ length: 4 }, (_, index) => shown({ id: `v-${index}`, expanded: true }))],
    pending: [{ id: "waiting", message: "排队提示", type: "info" }] };
  const next = noticeReducer(current, { type: "remove", id: "a", expectedExit: exiting, now: 5180 });
  assert.equal(next.visible.some(notice => notice.id === "a"), false);
  assert.equal(next.visible.at(-1).id, "waiting");
  assert.equal(next.visible.at(-1).shownAt, 5180);
  assert.equal(next.pending.length, 0);
});
