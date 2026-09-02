import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeAskQuestionnairePreview } = await createJiti(import.meta.url).import("./ask-questionnaire-preview.ts");

test("单反引号 text 围栏只移除首尾标记", () => {
  assert.equal(
    normalizeAskQuestionnairePreview("`text\nM M M | I I I\n------+------\nG G G | R R R\n`"),
    "M M M | I I I\n------+------\nG G G | R R R",
  );
});

test("标准 Markdown 代码围栏和 CRLF 被规范化", () => {
  assert.equal(
    normalizeAskQuestionnairePreview("```text\r\nM M M\r\nG G G\r\n```"),
    "M M M\nG G G",
  );
});

test("没有完整围栏的预览保持原文", () => {
  const preview = "M M M\nG ` G\nD D D";
  assert.equal(normalizeAskQuestionnairePreview(preview), preview);
});
