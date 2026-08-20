import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { fetchSessionContext } = await createJiti(import.meta.url).import("./session-load-client.ts");

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

test("context 客户端统一传递 leaf 与 defer 参数", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      context: { messages: [{ role: "user", content: "hi" }], entryIds: ["u1"], thinkingLevel: "off", model: null },
      leafId: "leaf-1",
    }));
  };

  const result = await fetchSessionContext("session/1", new AbortController().signal, { leafId: "leaf-1" });
  assert.equal(result.kind, "loaded");
  assert.match(requestedUrl, /session%2F1\/context/);
  assert.match(requestedUrl, /leafId=leaf-1/);
  assert.match(requestedUrl, /deferThinking=1/);
  assert.match(requestedUrl, /deferMedia=1/);
});

test("context 客户端拒绝 messages 与 entryIds 错位", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    context: { messages: [{ role: "user", content: "hi" }], entryIds: [], thinkingLevel: "off", model: null },
    leafId: null,
  }));
  await assert.rejects(
    fetchSessionContext("sid", new AbortController().signal),
    /messages 与 entryIds 长度不一致/,
  );
});
