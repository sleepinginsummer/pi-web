import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("普通用户 prompt 在扩展抢占空闲边界时按 followUp 排队", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptCase = source.slice(
    source.indexOf('case "prompt": {'),
    source.indexOf('case "abort": {'),
  );

  assert.match(promptCase, /const streamingBehavior = requestedStreamingBehavior \?\? "followUp"/);
  assert.match(promptCase, /this\.inner\.prompt\([\s\S]*streamingBehavior,[\s\S]*source: "rpc"/);
  assert.match(promptCase, /!requestedStreamingBehavior && !this\.inner\.isStreaming/);
});
