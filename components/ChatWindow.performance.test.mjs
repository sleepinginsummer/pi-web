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
  assert.match(indexSource, /const writtenFilesByFinalAssistant = new Map/);
  assert.match(indexSource, /for \(let index = 0; index < messages\.length; index\+\+\)/);
  assert.match(indexSource, /\}, \[messageCwd, messages\]\);/);
  assert.doesNotMatch(indexSource, /buildMessageRenderGroups/);
  assert.match(renderSource, /const \{ toolResults, visibleRefIndexByMessage, assistantTimestampIndices, writtenFilesByFinalAssistant \} = messageRenderIndex/);
  assert.doesNotMatch(renderSource, /for \(let j = idx \+ 1; j < messages\.length; j\+\+\)/);
  assert.doesNotMatch(renderSource, /new Map<string, ToolResultMessage>/);
});

test("本地渲染窗口耗尽后继续请求服务端历史页", () => {
  assert.match(source, /visibleCount < messages\.length/);
  assert.match(source, /hasEarlierMessages && !loadingEarlierMessages/);
  assert.match(source, /void loadEarlierMessages\(\)/);
  assert.match(source, /const hasMore = startIndex > 0 \|\| hasEarlierMessages/);
});
