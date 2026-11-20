import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { backfillFirstPage, mergeOlderPage, sameSessionView, FIRST_PAGE_BACKFILL_LIMIT } = await jiti.import("./first-page-backfill.ts");

const page = (ids, { oldestEntryId = ids[0] ?? null, hasMore = true, text } = {}) => ({
  snapshot: {
    entryIds: ids,
    messages: ids.map((id) => ({ role: "user", content: text ?? id })),
    oldestEntryId,
    hasMore,
  },
  leafId: "leaf",
});

/** 首屏那一页：补页只看它和后续响应，不看客户端状态。 */
const firstPage = (ids, { oldestEntryId = ids[0] ?? null, hasMore = true, text } = {}) => ({
  entryIds: ids,
  messages: ids.map((id) => ({ role: "user", content: text ?? id })),
  oldestEntryId,
  hasMore,
});

test("首屏有内容时不补页", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage(["a"]),
    readOlder: async () => { reads += 1; return page(["z"]); },
    commit: () => true,
  });
  assert.equal(pages, 0);
  assert.equal(reads, 0);
});

test("首屏为空时继续向前补，直到拿到消息", async () => {
  const seen = [];
  const committed = [];
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: "empty-1", hasMore: true }),
    readOlder: async (before) => {
      seen.push(before);
      // 第三页才有消息；前两页仍然是过程记录。
      if (before === "empty-1") return page([], { oldestEntryId: "empty-2", hasMore: true });
      if (before === "empty-2") return page([], { oldestEntryId: "empty-3", hasMore: true });
      return page(["u1", "a1"], { hasMore: false });
    },
    commit: (p) => { committed.push(p.snapshot.entryIds); return true; },
  });
  assert.deepEqual(seen, ["empty-1", "empty-2", "empty-3"], "游标要按上一页的 oldestEntryId 前进");
  assert.equal(pages, 3);
  assert.deepEqual(committed.at(-1), ["u1", "a1"]);
});

test("没有更早的页时不再请求", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: null, hasMore: false }),
    readOlder: async () => { reads += 1; return page(["z"]); },
    commit: () => true,
  });
  assert.equal(pages, 0);
  assert.equal(reads, 0);
});

test("重复的页会被拒绝，不会把同一段历史插两遍", async () => {
  let commits = 0;
  const pages = await backfillFirstPage({
    first: firstPage(["kept"], { oldestEntryId: "kept", hasMore: true }),
    // 服务端把已经在首屏里的 entryId 又给了一次。
    readOlder: async () => page(["kept", "older"], { oldestEntryId: "older", hasMore: true }),
    commit: () => { commits += 1; return true; },
  });
  assert.equal(pages, 0);
  assert.equal(commits, 0);
});

test("补页有上限，翻不到就交给「加载更早消息」", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: "cursor-0", hasMore: true }),
    readOlder: async () => {
      reads += 1;
      return page([], { oldestEntryId: `cursor-${reads}`, hasMore: true });
    },
    commit: () => true,
  });
  assert.equal(pages, FIRST_PAGE_BACKFILL_LIMIT);
  assert.equal(reads, FIRST_PAGE_BACKFILL_LIMIT);
});

test("提交失败（会话切走）立即停止", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: "cursor-0", hasMore: true }),
    readOlder: async () => { reads += 1; return page([], { oldestEntryId: "cursor-x", hasMore: true }); },
    commit: () => false,
  });
  assert.equal(pages, 0);
  assert.equal(reads, 1);
});

test("游标没有前进时立刻停止，不会重复请求同一段历史", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: "cursor-0", hasMore: true }),
    // 服务端没认出 before，把同一页又给了一遍。
    readOlder: async () => { reads += 1; return page([], { oldestEntryId: "cursor-0", hasMore: true }); },
    commit: () => true,
  });
  assert.equal(reads, 1, "只发一次，发现游标没动就停");
  assert.equal(pages, 1);
});

test("没有游标的页同样停下", async () => {
  let reads = 0;
  const pages = await backfillFirstPage({
    first: firstPage([], { oldestEntryId: "cursor-0", hasMore: true }),
    readOlder: async () => { reads += 1; return page([], { oldestEntryId: null, hasMore: false }); },
    commit: () => true,
  });
  assert.equal(reads, 1);
  assert.equal(pages, 1);
});

test("合并时保留首屏元数据，只从旧页取消息与游标", () => {
  const first = {
    messages: [{ role: "assistant", content: "tail" }],
    entryIds: ["a2"],
    oldestEntryId: "a2",
    hasMore: true,
    turnsBefore: 67,
    thinkingLevel: "max",
    model: { provider: "p", modelId: "m-tail" },
    totalActiveMs: 1234,
    shadowMindEnabled: false,
    version: "v-tail",
  };
  const older = {
    messages: [{ role: "user", content: "old" }],
    entryIds: ["u1"],
    oldestEntryId: "u1",
    hasMore: true,
    turnsBefore: 70,
    thinkingLevel: "off",
    model: { provider: "p", modelId: "m-old" },
    totalActiveMs: 1,
    shadowMindEnabled: true,
    version: "v-old",
  };

  const merged = mergeOlderPage(first, older);

  assert.deepEqual(merged.entryIds, ["u1", "a2"], "旧页在前");
  assert.deepEqual(merged.messages.map((message) => message.content), ["old", "tail"]);
  assert.equal(merged.oldestEntryId, "u1", "游标取更早那页");
  assert.equal(merged.hasMore, older.hasMore);
  assert.equal(merged.turnsBefore, 70, "轮次编号随更早的页");
  // 会话尾部的设置不能被「从 before 往上算」的旧值覆盖。
  assert.equal(merged.thinkingLevel, "max");
  assert.deepEqual(merged.model, { provider: "p", modelId: "m-tail" });
  assert.equal(merged.version, "v-tail");
  assert.equal(merged.totalActiveMs, 1234);
  assert.equal(merged.shadowMindEnabled, false);
});

test("补页的页必须和首屏属于同一个会话视图", () => {
  const first = { version: "v1", leafId: "leaf-1" };
  assert.equal(sameSessionView(first, { version: "v1", leafId: "leaf-1" }), true);
  // 文件在两次请求之间被重写：版本变了，两页的记录接不上。
  assert.equal(sameSessionView(first, { version: "v2", leafId: "leaf-1" }), false);
  // 同一版本但切了分支末端：补页取的是另一条分支的历史。
  assert.equal(sameSessionView(first, { version: "v1", leafId: "leaf-2" }), false);
  assert.equal(sameSessionView({ version: "v1", leafId: null }, { version: "v1", leafId: null }), true);
});
