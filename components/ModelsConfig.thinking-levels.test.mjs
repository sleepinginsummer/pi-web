import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");

test("模型配置编辑器复用 SDK 思考等级契约且不展示 auto", () => {
  assert.match(source, /import \{ THINKING_LEVELS, type ThinkingLevel \} from "@\/lib\/thinking-levels"/);
  assert.match(source, /thinkingLevelMap\?: ThinkingLevelMap/);
  assert.doesNotMatch(source, /const THINKING_LEVELS =/);
});

test("配置模型与选择器 DTO 使用不同命名", () => {
  assert.match(source, /interface ModelConfigEntry/);
  assert.doesNotMatch(source, /interface ModelEntry/);
});
