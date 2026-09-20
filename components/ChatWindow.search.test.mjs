import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("消息没有 entryId 时不会解引用空的搜索目标", () => {
  assert.match(
    source,
    /searchBlockIndex=\{pendingSearchScroll && entryIds\[idx\] === pendingSearchScroll\.entryId\s+\? pendingSearchScroll\.blockIndex\s+: undefined\}/,
  );
  assert.doesNotMatch(
    source,
    /entryIds\[idx\] === pendingSearchScroll\?\.entryId \? pendingSearchScroll\.blockIndex/,
  );
});
