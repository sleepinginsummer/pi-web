import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeAssistantMessage } = await createJiti(import.meta.url).import("./normalize.ts");

function assistant(content) {
  return { role: "assistant", content, model: "test", provider: "test" };
}

test("将完整的 thinking 文本块转换为思考块并保留后续文本", () => {
  const result = normalizeAssistantMessage(assistant([
    { type: "text", text: "<thinking>内部推理</thinking>\n最终回答" },
  ]));
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "内部推理" },
    { type: "text", text: "最终回答" },
  ]);
});

test("不转换正文中或未闭合的 thinking 标签", () => {
  const blocks = [
    { type: "text", text: "正文 <thinking>示例</thinking>" },
    { type: "text", text: "<thinking>未闭合" },
  ];
  assert.deepEqual(normalizeAssistantMessage(assistant(blocks)).content, blocks);
});
