import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const navigation = await readFile(new URL("../hooks/useSessionNavigation.ts", import.meta.url), "utf8");

test("首帧不读取标签页存储，挂载后才恢复", () => {
  assert.match(shell, /useState\(\(\) => getInitialNavigation\(searchParams \?\? new URLSearchParams\(\)\)\)/);
  assert.match(shell, /useLayoutEffect\(\(\) => \{\s+const next = withTabOpen\(initialNavigation, getTabOpen\(\)\)/);
  assert.match(shell, /if \(next\.sessionId\) markInitialRestorePending\(\)/);
  assert.doesNotMatch(shell, /suppressHydrationWarning/);
});

test("恢复会话更新 URL，显式新会话在本标签记住 cwd", () => {
  assert.match(navigation, /if \(!isRestore \|\| new URLSearchParams\(window\.location\.search\)\.get\("session"\) !== session\.id\) \{\s+replaceSessionUrl\(session\.id\)/);
  assert.match(navigation, /setTabOpenNewSession\(cwd\);[\s\S]*?url\.searchParams\.set\("cwd", cwd\)/);
});

test("切换与删除会话时标签页记忆不回跳旧会话", () => {
  assert.match(navigation, /setTabOpenSession\(selectedSession\.id\)/);
  assert.match(navigation, /clearTabOpenSession\(sessionId\);[\s\S]*?setSelectedSession\(null\)/);
});
