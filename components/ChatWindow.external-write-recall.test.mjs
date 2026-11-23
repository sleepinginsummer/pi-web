import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("the load-error page offers a Recall entry while queued messages exist", () => {
  const errorView = source.slice(source.indexOf("  if (error) {"), source.indexOf("  return (\n    <div\n      className=\"chat-window"));

  // 外部写入时 /context 一直 409：没有这条入口，刷新后消息只能留在服务器内存里等回收。
  assert.match(errorView, /const recallable = blockedRecall \? /);
  assert.match(errorView, /recallable > 0 \? \(/);
  assert.match(errorView, /handleRecallBlockedQueue\(\)/);
  assert.match(errorView, /chat\.externalWriteRecall/);
  // 普通加载错误也可能剩着可取回的消息：不要提「另一个程序写入了这个会话文件」。
  assert.match(errorView, /\{externalWriteBlocked\s*\? t\("chat\.externalWriteRecallHint", \{ count: recallable \}\)\s*: t\("chat\.queuedRecallHint", \{ count: recallable \}\)\}/);
  // 取回后重读仍失败时草稿只在内存里：保留恢复状态，给一个只重试读取的按钮，别让用户刷新。
  assert.match(errorView, /recalledPending \? \(/);
  assert.match(errorView, /chat\.externalWriteRecalled/);
  // 重试按钮始终在：错误会从外部写入变成普通 500，那时两个标记都可能为假。
  assert.doesNotMatch(errorView, /\(externalWriteBlocked \|\| recalledPending\) && \(/);
  assert.match(errorView, /handleRetryBlockedLoad/);
  assert.match(errorView, /chat\.externalWriteRetry/);
  // 服务端那句话是「等写入完成后刷新」，而这时刷新会丢掉刚取回的消息：换成应用内提示。
  assert.match(errorView, /externalWriteBlocked && recalledPending \? \(/);
  assert.match(errorView, /chat\.externalWriteBlockedTitle/);
  // clear_queue 失败时原因写在这里：错误页盖住了 NoticeShelf。
  assert.match(errorView, /recallError && <div className="text-red-400">\{recallError\}<\/div>/);
});
