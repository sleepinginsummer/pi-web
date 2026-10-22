import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../hooks/useFilePanel.ts", import.meta.url), "utf8");

test("历史哨兵用 state 保存，出现时即重新挂载 observer（#896）", () => {
  assert.match(source, /const \[sentinel, setSentinel\] = useState<HTMLDivElement \| null>\(null\);/);
  assert.match(source, /<div ref=\{setSentinel\}/);
  assert.doesNotMatch(source, /sentinelRef/);
  const effect = source.slice(source.indexOf("    if (!sentinel || !container || pendingScrollRestore || !initialScrollSettled) return;"));
  assert.match(effect.slice(0, effect.indexOf("observer.disconnect()") + 400), /scrollContainerRef, sentinel, visibleCount\]\);/);
});

test("文件标签按项目暂存，卸载中的查看器按渲染代数回写自己的项目", () => {
  assert.match(panelSource, /const switchWorkspace = useCallback\(\(currentKey: string \| null, nextKey: string\) => \{/);
  assert.match(panelSource, /switchFileWorkspace\(parkedWorkspacesRef\.current, currentKey, nextKey,/);
  assert.match(panelSource, /workspaceGenerationRef\.current \+= 1;/);
  assert.match(panelSource, /if \(generation !== workspaceGenerationRef\.current\) \{\s*saveParkedFileViewerState\(parkedWorkspacesRef\.current, generation, tabId, viewerRevision, viewerState\);\s*return;/);
});
