import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./TrashSessionDetail.tsx", import.meta.url), "utf8");

test("回收站的大纲跳转和主聊天一样给最终回答打标记", () => {
  // 答复与过程副本共用同一个 entryId：答复那次渲染要带答案容器标记，标题也只在它上面打标记。
  assert.match(source, /data-answer=\{final \? "1" : undefined\}/);
  assert.match(source, /markAnswerHeadings=\{final\}/);
  // 组里最后那条助手消息按答复渲染（第三个参数是 final）。
  assert.match(source, /renderMessage\(views\.answer, group\.finalAssistantIdx, true\)/);
});

test("过程详情里的副本不认领 ref，展开时不会顶掉答复的节点", () => {
  // 过程详情默认折叠、展开才挂载：它若共用同一个 ref，展开后大纲就找不到可点的标题。
  assert.match(source, /ref=\{attachRef && refIndices\[index\] >= 0 \? \(element\) => \{ messageRefs\.current\[refIndices\[index\]\] = element; \} : undefined\}/);
  assert.match(source, /renderMessage\(message, index, false, false\)/);
});
