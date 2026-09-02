import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});

test("运行中的处理过程只挂载最近三项并可按需展开", () => {
  assert.match(source, /const LIVE_PROCESS_ITEM_LIMIT = 3/);
  assert.match(source, /buildRecentItemWindow\([\s\S]*?LIVE_PROCESS_ITEM_LIMIT/);
  assert.match(source, /expanded \? renderAll\(\) : renderRecent\(\)/);
  assert.match(source, /visibleBlockOffset=\{options\.visibleBlockOffset\}/);
});
