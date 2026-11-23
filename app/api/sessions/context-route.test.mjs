// Static + behavior coverage for the context pagination API (the #555 transfer fix):
// ?tail bounds the returned chain, ?before rewinds the walk and excludes its own
// boundary so prepending the page never duplicates it. Data behavior is covered
// end-to-end in lib/session-reader.pagination.test.mjs; here we assert the route wires
// the params through to buildSessionContext (excludeLeaf on ?before).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = await readFileSync(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { buildSessionContext } = await jiti.import("@/lib/session-reader");

test("context route parses ?tail and ?before, excluding the boundary on paging", () => {
  assert.match(routeSrc, /const tail = Number\.isFinite\(rawTail\) && rawTail > 0 \? Math\.min\(rawTail, 1000\) : 50/);
  assert.match(routeSrc, /const before = url\.searchParams\.get\("before"\)/);
  assert.match(routeSrc, /readIndexedContextPage\(filePath, \{ leafId, before, tail \}\)/);
  assert.match(routeSrc, /const activeLeafId = leafId \?\? live\?\.leafId \?\? indexed!\.leafId/);
  assert.match(routeSrc, /buildSessionContext\(entries, contextLeafId, \{/);
  assert.match(routeSrc, /excludeLeaf: Boolean\(before && live\)/);
  assert.match(routeSrc, /leafId: activeLeafId/);
  assert.match(routeSrc, /"Server-Timing"/);
  assert.match(routeSrc, /"X-Session-Version": version/);
});

test("存活会话的 304 判断发生在建树之前", () => {
  // 建树是这份快照里最贵的一步（每条记录一个节点）：版本没变就别建。
  const probeIndex = routeSrc.indexOf("liveSessionBrowseVersion(id)");
  const snapshotIndex = routeSrc.indexOf("await readSessionBrowseSnapshot(id)");
  assert.ok(probeIndex > 0, "先探版本");
  assert.ok(snapshotIndex > probeIndex, "304 之后才建快照");
  assert.match(routeSrc, /if \(ifNoneMatch === etag\) \{/);
  // 带 before 的分页请求不参与 304（要拿到下一页，不是复用上一页）。
  assert.match(routeSrc, /const ifNoneMatch = before \? null : req\.headers\.get\("if-none-match"\);/);
});

test("context route: ?before pages upward without duplicating the boundary", () => {
  const entries = [];
  for (let i = 0; i < 100; i++) {
    entries.push({ id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, type: "message", timestamp: new Date(1000 + i * 1000).toISOString(), message: { role: "user", content: `m${i}` } });
  }
  const page1 = buildSessionContext(entries, "e99", { tail: 5 }).entryIds;
  assert.deepEqual(page1, ["e95", "e96", "e97", "e98", "e99"]);
  const oldest = page1[0]; // e95
  const page2 = buildSessionContext(entries, oldest, { tail: 5, excludeLeaf: true }).entryIds;
  assert.equal(page2[page2.length - 1], "e94");
  assert.ok(!page2.includes(oldest), "boundary `before` must not be duplicated");
  assert.ok(page1.every((id) => !page2.includes(id)), "adjacent pages share no entry");
});

test("context route data reports when pagination reaches the root", () => {
  const entries = [
    { id: "e0", parentId: null, type: "message", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "root" } },
  ];
  const page = buildSessionContext(entries, "e0", { tail: 50, excludeLeaf: true });
  assert.deepEqual(page.entryIds, []);
  assert.equal(page.hasMore, false);
});

test("分支尾页保留未投影成聊天的改名记录，并排除旁支", () => {
  const timestamp = new Date(1000).toISOString();
  const entries = [
    { id: "user", parentId: null, type: "message", timestamp, message: { role: "user", content: "问题" } },
    { id: "rename", parentId: "user", type: "session_info", timestamp, name: "新名称" },
    { id: "other", parentId: "user", type: "session_info", timestamp, name: "旁支" },
    { id: "answer", parentId: "rename", type: "message", timestamp, message: { role: "assistant", content: "答复" } },
  ];
  const page = buildSessionContext(entries, "answer", { tail: 10 });
  assert.deepEqual(page.entryIds, ["user", "answer"]);
  assert.deepEqual(page.branchTailEntryIds, ["user", "rename", "answer"]);
  assert.deepEqual(buildSessionContext(entries, "other", { tail: 10 }).branchTailEntryIds, ["user", "other"]);
  assert.equal(buildSessionContext(entries, "answer", { tail: 10, excludeLeaf: true }).branchTailEntryIds, undefined);
});

test("context 首屏先检查外部写入，运行中返回冲突而不是读取旧 wrapper", () => {
  assert.match(routeSrc, /liveRpc\.diskFreshness\(\)/);
  assert.match(routeSrc, /liveRpc\.isRunning\(\)/);
  assert.match(routeSrc, /liveRpc\.evictIfDiskAhead\(\)/);
  assert.ok(routeSrc.indexOf("liveRpc.diskFreshness()") < routeSrc.indexOf("readSessionBrowseSnapshot(id)"));
});
