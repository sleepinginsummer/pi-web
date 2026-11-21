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
const { cachedHasOutlineHeadings, hasOutlineHeadings, joinAnswerBlocks, outlineHeadingsFromBlocks, scanOutlineLines } = await jiti.import("./outline-headings.ts");

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

test("分隔线 - - - 不是列表：下面的两格缩进标题仍算顶层标题", () => {
  const markdown = "结论如下：\n\n- - -\n\n  ## 标题甲\n\n正文。";

  // 正文把 `- - -` 渲染成分隔线，`## 标题甲` 是顶层标题；大纲必须认同一个。
  assert.deepEqual(scanOutlineLines(markdown).filter((line) => line.kind === "heading"), [
    { kind: "heading", level: 2, text: "标题甲" },
  ]);
  assert.equal(hasOutlineHeadings(markdown), true, "有标题才渲染展开入口");
  // `***` / `_ _ _` 同样是分隔线。
  for (const rule of ["***", "* * *", "___", "_ _ _"]) {
    assert.deepEqual(extractOutlineHeadings(`${rule}\n\n  ## 标题甲`), [{ level: 2, text: "标题甲" }], rule);
  }
  // 分隔线仍会按缩进结束更深的列表（这里是顶格的列表项）。
  assert.deepEqual(extractOutlineHeadings("- 列表项\n\n- - -\n\n## 标题乙"), [{ level: 2, text: "标题乙" }]);
  // 列表项内部的分隔线不结束这一项，它下面的标题依旧是嵌套标题。
  assert.deepEqual(extractOutlineHeadings("- 列表项\n  - - -\n  ## 嵌套"), []);
});

test("列表项里的围栏随容器结束而结束，和正文渲染同一规则", () => {
  // 未闭合的围栏不会跨出它所在的列表项：缩进退回顶层时正文恢复成 Markdown，
  // 那里的 `##` 在正文里是标题，大纲也必须认。
  const cases = [
    ["- 列表项\n  ```js\n  const a = 1\n## 标题", ["标题"]],
    // 围栏有结束标记、标题仍缩进在列表项内：正文里是嵌套标题，大纲不算。
    ["- 列表项\n  ```\n  x\n  ```\n  ## 嵌套", []],
    // 顶格的围栏不属于上一项：它是代码块，后面的标题仍是代码。
    ["- 列表项\n```\ncode\n## 标题", []],
    // 顶层未闭合围栏照旧吞掉后面的 #。
    ["```\n# 不是标题", []],
    // 新列表项打断上一项里的围栏。
    ["- a\n  ```\n  code\n- b\n## 标题", ["标题"]],
  ];
  for (const [markdown, expected] of cases) {
    assert.deepEqual(extractOutlineHeadings(markdown).map((heading) => heading.text), expected, markdown);
  }
});

test("逐块解析的顶层标题与服务端大纲、正文一致", () => {
  // 分隔线后的标题：分隔线不再被当成列表，两种口径都能扫到它。
  const separatorBlocks = ["**结论**\n\n- - -", "  ## 分隔线后的标题"];
  assert.deepEqual(outlineHeadingsFromBlocks(separatorBlocks), [{ level: 2, text: "分隔线后的标题" }]);
  assert.deepEqual(extractOutlineHeadings(joinAnswerBlocks(separatorBlocks)), [{ level: 2, text: "分隔线后的标题" }]);

  // 前一块是列表时，后一块的两格缩进标题拼进去就成了嵌套：只有逐块解析能保住它。
  const listBlocks = ["- 第一点\n- 第二点", "  ## 块首缩进标题"];
  assert.deepEqual(outlineHeadingsFromBlocks(listBlocks), [{ level: 2, text: "块首缩进标题" }]);
  assert.deepEqual(extractOutlineHeadings(joinAnswerBlocks(listBlocks)), [], "拼接后会丢，所以服务端不能拼接");
  assert.deepEqual(outlineHeadingsFromBlocks(["## 甲", "## 乙", "## 丙"], 2), [
    { level: 2, text: "甲" },
    { level: 2, text: "乙" },
  ], "上限跨块生效");

  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "2026-11-21T00:00:00Z", message: { role: "user", content: "问题" } },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      timestamp: "2026-11-21T00:00:01Z",
      message: { role: "assistant", content: listBlocks.map((text) => ({ type: "text", text })) },
    },
  ];
  assert.deepEqual(buildSessionOutlineFromEntries(entries).turns[0].headings, [
    { level: 2, text: "块首缩进标题" },
  ]);
});

test("父链成环时大纲不会卡死", () => {
  // 手改坏的文件可能让自己当自己的祖先：遍历必须能停下来。
  const entries = [
    { id: "u1", parentId: "a1", type: "message", timestamp: "2026-11-21T00:00:00Z", message: { role: "user", content: "问题" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "2026-11-21T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "## 回答" }] } },
  ];
  const outline = buildSessionOutlineFromEntries(entries, "a1");
  assert.equal(outline.turns.length, 1);
  assert.deepEqual(outline.turns[0].headings, [{ level: 2, text: "回答" }]);
});

test("大纲按正文的文本块逐个取标题，拼接不会把后一块的缩进标题并进列表", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "2026-11-20T00:00:00Z", message: { role: "user", content: "问题" } },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      timestamp: "2026-11-20T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "下面几点：\n\n- 第一点\n- 第二点" },
          { type: "text", text: "  ## 标题甲\n\n正文\n\n## 标题乙" },
        ],
      },
    },
  ];

  const { turns } = buildSessionOutlineFromEntries(entries);
  // 正文逐块渲染，两个标题都能点到；服务端必须给同样的两条，未加载轮次和已加载轮次才对得上。
  assert.deepEqual(turns[0].headings, [{ level: 2, text: "标题甲" }, { level: 2, text: "标题乙" }]);
  assert.equal(turns[0].answerSummary.length > 0, true);
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

test("大纲文本保留标识符里的下划线与乘号，只去掉真正的强调", () => {
  const md = [
    "## 更新 list_shadows 与 get_shadow_config",
    "## 计算 5 * 3 * 2 的结果",
    "## 用 *斜体* 和 **粗体** 标注",
    "## 保留 snake_case 的说明",
  ].join("\n");

  assert.deepEqual(extractOutlineHeadings(md), [
    { level: 2, text: "更新 list_shadows 与 get_shadow_config" },
    { level: 2, text: "计算 5 * 3 * 2 的结果" },
    { level: 2, text: "用 斜体 和 粗体 标注" },
    { level: 2, text: "保留 snake_case 的说明" },
  ]);
});

test("缩进四格的围栏行是缩进代码，不能吞掉后面的标题", () => {
  const md = ["    ```", "## 缩进代码之后的标题", "    ```"].join("\n");
  assert.deepEqual(extractOutlineHeadings(md), [{ level: 2, text: "缩进代码之后的标题" }]);
});

test("列表项里的标题不算大纲标题，正文里它没有标记", () => {
  // 正文逐个文本块渲染，remark 只给顶层 h1/h2 打 data-answer-heading；
  // 列表项内的标题是嵌套节点，大纲若把它算一条，编号就会整体后移。
  assert.deepEqual(
    extractOutlineHeadings("- 第一点\n  # 列表里的标题\n- 第二点\n\n## 顶层标题"),
    [{ level: 2, text: "顶层标题" }],
  );
  assert.deepEqual(
    extractOutlineHeadings("1. 步骤\n   ## 步骤小标题\n\n## 结论"),
    [{ level: 2, text: "结论" }],
  );
  assert.deepEqual(
    extractOutlineHeadings("- a\n  - b\n    ## 深层标题\n\n## 顶层"),
    [{ level: 2, text: "顶层" }],
  );
  // 缩进回到列表项内容之外，标题就又算顶层了（空格不超过三个）。
  assert.deepEqual(
    extractOutlineHeadings("- 列表项\n\n # 一格缩进的标题"),
    [{ level: 1, text: "一格缩进的标题" }],
  );
});

test("没有列表时，缩进两三格的顶层标题照常识别", () => {
  // CommonMark 允许顶层 ATX 标题缩进最多三个空格；逐块渲染时它仍是顶层节点。
  assert.deepEqual(
    extractOutlineHeadings("  ## 标题甲\n\n正文\n\n## 标题乙"),
    [{ level: 2, text: "标题甲" }, { level: 2, text: "标题乙" }],
  );
});

test("标题数量上限为 0 时一条都不返回", () => {
  assert.deepEqual(extractOutlineHeadings("# 一\n\n## 二", 0), []);
  assert.deepEqual(extractOutlineHeadings("# 一\n\n## 二", 1), [{ level: 1, text: "一" }]);
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

test("磁盘与内存大纲都和主对话一样找回更早的真实回答", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outline-window-"));
  const filePath = join(dir, "session.jsonl");
  const entryAt = (second) => new Date(Date.UTC(2026, 10, 20, 0, 0, second)).toISOString();
  const fixture = (tailCount) => {
    const entries = [
      { id: "u1", parentId: null, type: "message", timestamp: entryAt(0), message: { role: "user", content: "问题" } },
      { id: "a-answer", parentId: "u1", type: "message", timestamp: entryAt(1), message: { role: "assistant", content: [{ type: "text", text: "# 结论\n\n真实回答。" }] } },
    ];
    let parentId = "a-answer";
    for (let index = 0; index < tailCount; index += 1) {
      const id = `tail-${index}`;
      entries.push({
        id,
        parentId,
        type: "message",
        timestamp: entryAt(2 + index),
        message: { role: "assistant", content: [{ type: "toolCall", id: `t${index}`, name: "read", arguments: {} }] },
      });
      parentId = id;
    }
    return entries;
  };
  try {
    // 与主对话一样不设回退上限：一长串工具调用/空中止之后仍要找回真实回答。
    for (const tailCount of [2, 9, 12]) {
      const entries = fixture(tailCount);
      const leaf = entries.at(-1).id;
      resetSessionOutlinesForTests();
      resetSessionContentIndexesForTests();
      const header = { type: "session", id: "s4", timestamp: entryAt(0), cwd: dir };
      writeFileSync(filePath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

      const memory = buildSessionOutlineFromEntries(entries, leaf);
      const disk = await readIndexedSessionOutline(filePath, leaf);
      assert.deepEqual(disk.turns, memory.turns, `${tailCount} 条空回复时两条路径必须一致`);
      assert.equal(memory.turns[0].finalAssistantEntryId, "a-answer", `${tailCount} 条空回复后仍要找到真实回答`);
      assert.deepEqual(memory.turns[0].headings, [{ level: 1, text: "结论" }]);
    }

    // 一整轮确实没有回答时，两条路径都退回最后一条助手记录，摘要为空。
    const noAnswer = [
      { id: "u2", parentId: null, type: "message", timestamp: entryAt(0), message: { role: "user", content: "第二轮" } },
      { id: "only-tool", parentId: "u2", type: "message", timestamp: entryAt(1), message: { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "read", arguments: {} }] } },
    ];
    resetSessionOutlinesForTests();
    resetSessionContentIndexesForTests();
    const header = { type: "session", id: "s5", timestamp: entryAt(0), cwd: dir };
    writeFileSync(filePath, `${[header, ...noAnswer].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const memory = buildSessionOutlineFromEntries(noAnswer, "only-tool");
    const disk = await readIndexedSessionOutline(filePath, "only-tool");
    assert.deepEqual(disk.turns, memory.turns);
    assert.equal(memory.turns[0].finalAssistantEntryId, "only-tool");
    assert.equal(memory.turns[0].answerSummary, "");
  } finally {
    resetSessionOutlinesForTests();
    resetSessionContentIndexesForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回答以四空格缩进的围栏开头时，完整大纲仍能找到后面的标题", () => {
  const entryAt = (second) => new Date(Date.UTC(2026, 10, 20, 0, 0, second)).toISOString();
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: entryAt(0), message: { role: "user", content: "问题" } },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      timestamp: entryAt(1),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "    ```\n    缩进代码\n    ```\n\n## 结论\n\n正文。" }],
      },
    },
  ];

  const outline = buildSessionOutlineFromEntries(entries, "a1");
  assert.equal(outline.turns.length, 1);
  assert.deepEqual(outline.turns[0].headings, [{ level: 2, text: "结论" }]);
});

test("joinAnswerBlocks 封住每块末尾的围栏，下一块的标题不会被当成代码", () => {
  const joined = joinAnswerBlocks(["说明\n\n```ts\nconst x = 1;", "## 结论\n\n正文。"]);
  assert.deepEqual(extractOutlineHeadings(joined), [{ level: 2, text: "结论" }], "第一块漏写闭合围栏，第二块的标题仍要算标题");
  assert.equal(joinAnswerBlocks(["```\ncode\n```"]), "```\ncode\n```", "已经闭合的块原样返回");
  assert.equal(joinAnswerBlocks(["~~~\ncode"]), "~~~\ncode\n~~~", "补的是同字符、同长度的围栏");
  assert.equal(joinAnswerBlocks([]), "");
});

test("围栏里混入另一种围栏字符的行是代码内容，不会提前关闭代码块", () => {
  // CommonMark：关闭围栏整行只能是同一种字符。开 ``` 之后的 ```~~~ 仍是代码。
  const md = ["```", "code", "```~~~", "## 这是代码", "```", "## 标题"].join("\n\n");
  assert.deepEqual(extractOutlineHeadings(md), [{ level: 2, text: "标题" }]);

  // 拼接器同样不能把它当闭合行：块末尾仍然开着围栏，要补一行关闭。
  const joined = joinAnswerBlocks(["```\ncode\n```~~~", "## 结论"]);
  assert.match(joined, /```~~~\n```\n\n## 结论/);
  assert.deepEqual(extractOutlineHeadings(joined), [{ level: 2, text: "结论" }]);
});

test("多个文本块时，前一块漏写围栏也不会吞掉后一块的标题（内存与磁盘一致）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outline-blocks-"));
  const filePath = join(dir, "session.jsonl");
  const entryAt = (second) => new Date(Date.UTC(2026, 10, 20, 0, 0, second)).toISOString();
  // 两种“漏写闭合”的写法：直接没写；以及写了一行看着像闭合、Markdown 解析器却不认的
  // 混合围栏（```~~~）。两种情形下第二块的标题都必须出现在内存与磁盘大纲里。
  const firstBlocks = [
    "先看代码：\n\n```ts\nconst x = 1;",
    "看示例：\n\n```\nconst x = 1;\n```~~~",
  ];
  const header = { type: "session", id: "s6", timestamp: entryAt(0), cwd: dir };
  try {
    for (const firstBlock of firstBlocks) {
      const entries = [
        { id: "u1", parentId: null, type: "message", timestamp: entryAt(0), message: { role: "user", content: "问题" } },
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          timestamp: entryAt(1),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: firstBlock },
              { type: "text", text: "## 结论\n\n正文。" },
            ],
          },
        },
      ];
      resetSessionOutlinesForTests();
      resetSessionContentIndexesForTests();
      writeFileSync(filePath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      const memory = buildSessionOutlineFromEntries(entries, "a1");
      const disk = await readIndexedSessionOutline(filePath, "a1");
      assert.deepEqual(disk.turns, memory.turns, firstBlock);
      assert.deepEqual(memory.turns[0].headings, [{ level: 2, text: "结论" }], firstBlock);
      assert.match(memory.turns[0].answerSummary, /正文/);
    }
  } finally {
    resetSessionOutlinesForTests();
    resetSessionContentIndexesForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("标题判定结果按正文缓存，满了丢最早的一条", () => {
  const cache = new Map();
  assert.equal(cachedHasOutlineHeadings(cache, "## 标题"), true);
  assert.equal(cachedHasOutlineHeadings(cache, "普通正文"), false);
  assert.deepEqual([...cache.keys()], ["## 标题", "普通正文"]);

  // 上限 2：再来一条会把最早的那条挤出去，缓存不会随滚动无限长。
  assert.equal(cachedHasOutlineHeadings(cache, "### 三级不算标题", 2), false);
  assert.deepEqual([...cache.keys()], ["普通正文", "### 三级不算标题"]);
});

test("大纲标题的口径与正文渲染一致：HTML 块、反引号 info、frontmatter、数学块", () => {
  // 以下四种都曾被行扫描器判错：正文里有标题、大纲没有（漏展开入口），或反过来。
  assert.deepEqual(
    extractOutlineHeadings("<div>\n## 不是标题\n</div>\n\n## 真标题"),
    [{ level: 2, text: "真标题" }],
    "原样 HTML 块里的 # 不是标题",
  );
  assert.deepEqual(
    extractOutlineHeadings("```js`x\n## 标题甲\n```"),
    [{ level: 2, text: "标题甲" }],
    "反引号围栏的 info string 含反引号时它根本不是围栏",
  );
  assert.deepEqual(
    extractOutlineHeadings("---\ntitle: x\n## 不是标题\n---\n\n## 真标题"),
    [{ level: 2, text: "真标题" }],
    "frontmatter 里的 # 不是标题",
  );
  assert.deepEqual(
    extractOutlineHeadings("$$\n# 不是标题\n$$\n\n## 真标题"),
    [{ level: 2, text: "真标题" }],
    "$$ 数学块里的 # 不是标题",
  );
  assert.equal(hasOutlineHeadings("<div>\n## 不在大纲里\n</div>"), false);
});

test("大纲标题与正文共用同一条 Markdown 解析（按正文插件表复算）", async () => {
  // 正文：MarkdownBody 用 react-markdown + markdownRemarkPlugins，只给根节点 h1/h2 加跳转标记。
  const { markdownRemarkPlugins } = await jiti.import("./markdown.ts");
  const { unified } = await jiti.import("unified");
  const remarkParse = (await jiti.import("remark-parse")).default;
  const { normalizeDisplayMath } = await jiti.import("./display-math.ts");
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins);
  const nodeText = (node) => {
    if (typeof node.value === "string") return node.value;
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    return Array.isArray(node.children) ? node.children.map(nodeText).join("") : "";
  };
  // 正文先把 `\[…\]` 整理成 `$$…$$` 再解析（MarkdownBody 的 normalizeDisplayMath）。
  const bodyHeadings = (markdown) => processor.parse(normalizeDisplayMath(markdown)).children
    .filter((node) => node.type === "heading" && node.depth <= 2)
    .map((node) => ({ level: node.depth, text: nodeText(node).replace(/\s+/g, " ").trim() }))
    .filter((heading) => heading.text);

  const shapes = [
    "# 一\n\n正文\n\n## 二",
    "```\n# 代码\n```\n\n## 标题",
    "- 列表\n  ## 嵌套\n\n## 顶层",
    "<details>\n<summary>x</summary>\n\n## 块里的\n</details>\n\n## 块外的",
    "$$\n# 数学\n$$\n\n## 数学后",
    "---\na: 1\n---\n\n## 之后",
    "Setext 一级\n===\n\nSetext 二级\n---",
    "- - -\n\n  ## 分隔线后",
    "\\[\n## 不是标题\n\\]\n\n## 数学块之后",
    "$$\n## 不是标题\n$$\n\n## 数学块之后",
  ];
  for (const shape of shapes) {
    assert.deepEqual(extractOutlineHeadings(shape), bodyHeadings(shape), shape);
  }
});

test("`\\[…\\]` 数学块里的 ## 不算标题（正文也会先把它整理成 $$ 块）", () => {
  const markdown = "引子里的话\n\n\\[\nf(x) = x^2\n## 这是公式里的井号\n\\]\n\n## 真正的标题";
  assert.deepEqual(extractOutlineHeadings(markdown), [{ level: 2, text: "真正的标题" }]);
  // 多行公式的内容也一起被收进数学块，不会漏出成标题。
  const multiline = "\\[\n\\begin{aligned}\n## a\n\\end{aligned}\n\\]\n\n## 之后";
  assert.deepEqual(extractOutlineHeadings(multiline), [{ level: 2, text: "之后" }]);
});

test("大纲只列用户提问：后台命令与定时任务的唤醒轮次整行不出现", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "2026-11-20T00:00:00Z", message: { role: "user", content: "第一个提问" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "2026-11-20T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "第一轮回答" }] } },
    { id: "bg", parentId: "a1", type: "custom_message", customType: "pi-web:background-command", display: true, timestamp: "2026-11-20T00:00:02Z", content: 'Background command [x1] "取样" exited with code 0 after 3s\n$ sleep 1' },
    { id: "a2", parentId: "bg", type: "message", timestamp: "2026-11-20T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "命令跑完了" }] } },
    { id: "task", parentId: "a2", type: "custom_message", customType: "pi-web:scheduled-task", display: true, timestamp: "2026-11-20T00:00:04Z", content: '⏰ Scheduled task "每天九点" [t1] fired (每天 09:00).' },
    { id: "a3", parentId: "task", type: "message", timestamp: "2026-11-20T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "定时任务跑完了" }] } },
    { id: "u2", parentId: "a3", type: "message", timestamp: "2026-11-20T00:00:06Z", message: { role: "user", content: "第二个提问" } },
    { id: "a4", parentId: "u2", type: "message", timestamp: "2026-11-20T00:00:07Z", message: { role: "assistant", content: [{ type: "text", text: "第二轮回答" }] } },
  ];

  const outline = buildSessionOutlineFromEntries(entries, "a4");
  assert.deepEqual(outline.turns.map((turn) => turn.turnNumber), [1, 4]);
  assert.deepEqual(outline.turns.map((turn) => turn.userText), ["第一个提问", "第二个提问"]);
  // 配对仍按原始锚点算：第一轮的最终回答还是它自己的，不会串到后台命令那一轮。
  assert.equal(outline.turns[0].finalAssistantEntryId, "a1");
  assert.equal(outline.turns[0].answerSummary, "第一轮回答");
  assert.equal(outline.turns[1].finalAssistantEntryId, "a4");
});

