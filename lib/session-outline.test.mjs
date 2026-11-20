import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  extractOutlineHeadings,
  extractOutlineSummary,
  buildSessionOutlineFromEntries,
  readIndexedSessionOutline,
  resetSessionOutlinesForTests,
} = await jiti.import("./session-outline.ts");
const { resetSessionContentIndexesForTests } = await jiti.import("./session-content-index.ts");

test("extractOutlineHeadings 只提取 h1/h2 并忽略代码块内的 # 注释", () => {
  const md = [
    "# 一级标题 **加粗**",
    "正文段落",
    "```bash",
    "# 这只是 shell 注释",
    "## 这也是注释",
    "```",
    "## 二级标题 `code` [链接](https://example.com)",
    "### 三级标题不计入",
    "~~~~python",
    "# python comment",
    "~~~~",
    "## 总结",
  ].join("\n");

  assert.deepEqual(extractOutlineHeadings(md), [
    { level: 1, text: "一级标题 加粗" },
    { level: 2, text: "二级标题 code 链接" },
    { level: 2, text: "总结" },
  ]);
});

test("extractOutlineSummary 跳过代码块和标题，提取正文摘要", () => {
  const md = [
    "# 结论",
    "```ts",
    "const x = 1;",
    "```",
    "这里是第一段核心说明，包含 **重点** 和 [链接](https://example.com)。",
    "- 第二点补充说明",
  ].join("\n");

  assert.equal(extractOutlineSummary(md), "这里是第一段核心说明，包含 重点 和 链接。 第二点补充说明");
});

test("buildSessionOutlineFromEntries 仅取每轮最终回答，过滤中间过程回复与无关分支", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "2026-11-20T00:00:00Z", message: { role: "user", content: "第一轮问题" } },
    { id: "a1-mid", parentId: "u1", type: "message", timestamp: "2026-11-20T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "我先查一下代码" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] } },
    { id: "tr1", parentId: "a1-mid", type: "message", timestamp: "2026-11-20T00:00:02Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "huge file" }], isError: false } },
    { id: "a1-final", parentId: "tr1", type: "message", timestamp: "2026-11-20T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "## 根因\n\n状态被后一个 effect 覆盖。\n\n## 修复\n\n移入分支。" }] } },
    // 旁支（不在 leaf u2->a2 链上）
    { id: "u2-side", parentId: "a1-final", type: "message", timestamp: "2026-11-20T00:00:04Z", message: { role: "user", content: "旁支问题" } },
    // 主支第二轮
    { id: "u2", parentId: "a1-final", type: "message", timestamp: "2026-11-20T00:00:05Z", message: { role: "user", content: [{ type: "text", text: "第二轮问题" }] } },
    { id: "a2", parentId: "u2", type: "message", timestamp: "2026-11-20T00:00:06Z", message: { role: "assistant", content: [{ type: "text", text: "已完成第二轮验证。" }] } },
  ];

  const outline = buildSessionOutlineFromEntries(entries, "a2");
  assert.equal(outline.leafId, "a2");
  assert.equal(outline.turns.length, 2);
  assert.equal(outline.turns[0].turnNumber, 1);
  assert.equal(outline.turns[0].entryId, "u1");
  assert.equal(outline.turns[0].userText, "第一轮问题");
  assert.equal(outline.turns[0].finalAssistantEntryId, "a1-final");
  assert.deepEqual(outline.turns[0].headings, [
    { level: 2, text: "根因" },
    { level: 2, text: "修复" },
  ]);
  assert.equal(outline.turns[0].answerSummary, "状态被后一个 effect 覆盖。 移入分支。");

  assert.equal(outline.turns[1].turnNumber, 2);
  assert.equal(outline.turns[1].entryId, "u2");
  assert.equal(outline.turns[1].answerSummary, "已完成第二轮验证。");
  assert.deepEqual(outline.turns[1].headings, []);
});

test("readIndexedSessionOutline 通过磁盘索引构建全量分支大纲", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outline-"));
  const filePath = join(dir, "session.jsonl");
  resetSessionContentIndexesForTests();
  resetSessionOutlinesForTests();
  try {
    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-11-20T00:00:00Z", cwd: dir }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-11-20T00:00:01Z", message: { role: "user", content: "第 1 轮" } }),
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-20T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "# 方案\n\n先做轻量索引。" }] } }),
      JSON.stringify({ type: "message", id: "e3", parentId: "e2", timestamp: "2026-11-20T00:00:03Z", message: { role: "user", content: "第 2 轮" } }),
      JSON.stringify({ type: "message", id: "e4", parentId: "e3", timestamp: "2026-11-20T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "好的，已落盘。" }] } }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const outline = await readIndexedSessionOutline(filePath);
    assert.equal(outline.leafId, "e4");
    assert.equal(outline.turns.length, 2);
    assert.equal(outline.turns[0].userText, "第 1 轮");
    assert.deepEqual(outline.turns[0].headings, [{ level: 1, text: "方案" }]);
    assert.equal(outline.turns[1].userText, "第 2 轮");
    assert.equal(outline.turns[1].answerSummary, "好的，已落盘。");
  } finally {
    resetSessionOutlinesForTests();
    resetSessionContentIndexesForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractOutlineHeadings 同时识别 Setext 的 = / - 下划线标题", () => {
  const md = [
    "总体方案",
    "========",
    "",
    "正文段落",
    "",
    "第一步",
    "------",
    "",
    "- 列表项",
    "---",
    "```md",
    "围栏里的标题写法",
    "===",
    "```",
    "### 三级标题不计入",
  ].join("\n");

  assert.deepEqual(extractOutlineHeadings(md), [
    { level: 1, text: "总体方案" },
    { level: 2, text: "第一步" },
  ]);
});

test("extractOutlineSummary 不把 Setext 标题文字或下划线算进摘要", () => {
  const md = ["结论", "===", "第一句正文。", "", "细节", "---", "第二句正文。"].join("\n");
  assert.equal(extractOutlineSummary(md), "第一句正文。 第二句正文。");
});

test("本轮末尾只剩工具调用或空中止时，保留上一轮真实回答的摘要与标题", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "2026-11-20T00:00:00Z", message: { role: "user", content: "第一轮问题" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "2026-11-20T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "## 结论\n\n已经修好了。" }] } },
    { id: "a2", parentId: "a1", type: "message", timestamp: "2026-11-20T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] } },
    { id: "a3", parentId: "a2", type: "message", timestamp: "2026-11-20T00:00:03Z", message: { role: "assistant", content: [], stopReason: "aborted" } },
    { id: "u2", parentId: "a3", type: "message", timestamp: "2026-11-20T00:00:04Z", message: { role: "user", content: "第二轮问题" } },
    { id: "b1", parentId: "u2", type: "message", timestamp: "2026-11-20T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "第二轮的回答。" }] } },
  ];

  const outline = buildSessionOutlineFromEntries(entries, "b1");
  assert.equal(outline.turns[0].finalAssistantEntryId, "a1");
  assert.deepEqual(outline.turns[0].headings, [{ level: 2, text: "结论" }]);
  assert.equal(outline.turns[0].answerSummary, "已经修好了。");
  assert.equal(outline.turns[1].finalAssistantEntryId, "b1");
});

test("磁盘索引大纲与主对话同口径：末尾空回复不覆盖上一轮真实回答", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outline-empty-"));
  const filePath = join(dir, "session.jsonl");
  resetSessionContentIndexesForTests();
  resetSessionOutlinesForTests();
  try {
    const lines = [
      JSON.stringify({ type: "session", id: "s2", timestamp: "2026-11-20T00:00:00Z", cwd: dir }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-11-20T00:00:01Z", message: { role: "user", content: "第 1 轮" } }),
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-20T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "# 方案\n\n先做轻量索引。" }] } }),
      JSON.stringify({ type: "message", id: "e3", parentId: "e2", timestamp: "2026-11-20T00:00:03Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] } }),
      JSON.stringify({ type: "message", id: "e4", parentId: "e3", timestamp: "2026-11-20T00:00:04Z", message: { role: "assistant", content: [], stopReason: "aborted" } }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const outline = await readIndexedSessionOutline(filePath);
    assert.equal(outline.leafId, "e4");
    assert.equal(outline.turns.length, 1);
    assert.equal(outline.turns[0].finalAssistantEntryId, "e2");
    assert.deepEqual(outline.turns[0].headings, [{ level: 1, text: "方案" }]);
    assert.equal(outline.turns[0].answerSummary, "先做轻量索引。");

    // 第二次读取命中缓存：返回同一个对象，不必再逐条读记录。
    assert.equal(await readIndexedSessionOutline(filePath), outline);
  } finally {
    resetSessionOutlinesForTests();
    resetSessionContentIndexesForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
