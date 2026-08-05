import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("长会话渲染索引通过一次线性 memo 复用", () => {
  const indexSource = source.slice(
    source.indexOf("  const messageRenderIndex = useMemo"),
    source.indexOf("  const inputHistory = useMemo"),
  );
  const renderSource = source.slice(
    source.indexOf("            {(() => {"),
    source.indexOf("            })()}", source.indexOf("            {(() => {")),
  );

  assert.match(indexSource, /const toolResults = new Map/);
  assert.match(indexSource, /const visibleRefIndexByMessage = new Map/);
  assert.match(indexSource, /const assistantTimestampIndices = new Set/);
  assert.match(indexSource, /for \(let index = 0; index < messages\.length; index\+\+\)/);
  assert.match(indexSource, /\}, \[messages\]\);/);
  assert.match(renderSource, /const \{ toolResults, visibleRefIndexByMessage, assistantTimestampIndices \} = messageRenderIndex/);
  assert.doesNotMatch(renderSource, /for \(let j = idx \+ 1; j < messages\.length; j\+\+\)/);
  assert.doesNotMatch(renderSource, /new Map<string, ToolResultMessage>/);
});
