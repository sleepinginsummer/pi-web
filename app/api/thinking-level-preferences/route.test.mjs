import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("GET 和 POST 都只接收 modelId，不接收 provider", () => {
  assert.match(source, /searchParams\.get\("modelId"\)/);
  assert.doesNotMatch(source, /body\.provider|searchParams\.get\("provider"\)/);
});

test("POST 校验实际思考强度后调用事务存储", () => {
  assert.match(source, /isThinkingLevel\(body\.thinkingLevel\)/);
  assert.match(source, /await recordThinkingLevelUsage\(\{ modelId, thinkingLevel: body\.thinkingLevel \}\)/);
});
