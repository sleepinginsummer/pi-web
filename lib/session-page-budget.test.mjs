import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPageWalker, sessionPageBudget, MAX_PAGE_BYTES } = await jiti.import("./session-page-budget.ts");

test("凑满可见消息就收尾，不越过软上限", () => {
  const walker = createPageWalker(50);
  let stopped = 0;
  for (let i = 0; i < 500; i += 1) {
    stopped += 1;
    // 每条记录都是可见消息。
    if (walker.accept(true)) break;
  }
  assert.equal(stopped, 50);
  assert.equal(walker.counts().visible, 50);
});

test("页里已经有消息时，软上限到点就停", () => {
  const { softRecords } = sessionPageBudget(50);
  const walker = createPageWalker(50);
  let stopped = 0;
  for (let i = 0; i < softRecords + 100; i += 1) {
    stopped += 1;
    // 每 10 条记录里只有 1 条可见消息：凑不满 50 条，但页里有内容。
    if (walker.accept(i % 10 === 0)) break;
  }
  assert.equal(stopped, softRecords);
  assert.ok(walker.counts().visible > 0);
});

test("尾部连续非消息记录会越过软上限继续向前，凑够最小可见条数", () => {
  const { softRecords, minVisibleAfterOverflow } = sessionPageBudget(50);
  const walker = createPageWalker(50);
  let stopped = 0;
  const hidden = softRecords + 86; // 例如 shadow-mind-event / plan-mode-state 的长尾
  for (let i = 0; i < hidden + 100; i += 1) {
    stopped += 1;
    if (walker.accept(i >= hidden)) break;
  }
  assert.equal(stopped, hidden + minVisibleAfterOverflow);
  assert.equal(walker.counts().visible, minVisibleAfterOverflow);
  assert.equal(walker.counts().overflowed, true);
});

test("全是非消息记录时停在硬上限，不会把整条分支读进响应", () => {
  const { hardRecords } = sessionPageBudget(50);
  const walker = createPageWalker(50);
  let stopped = 0;
  for (let i = 0; i < hardRecords + 500; i += 1) {
    stopped += 1;
    if (walker.accept(false)) break;
  }
  assert.equal(stopped, hardRecords);
});

test("按字节预算收尾（磁盘索引路径）", () => {
  const walker = createPageWalker(50);
  const recordBytes = Math.floor(MAX_PAGE_BYTES / 4);
  let stopped = 0;
  for (let i = 0; i < 10; i += 1) {
    stopped += 1;
    if (walker.accept(false, recordBytes)) break;
  }
  assert.equal(stopped, 4);
  assert.ok(walker.counts().bytes >= MAX_PAGE_BYTES);
});

test("tail 越小最小可见条数也越小", () => {
  assert.equal(sessionPageBudget(3).minVisibleAfterOverflow, 3);
  assert.equal(sessionPageBudget(50).minVisibleAfterOverflow, 10);
});
