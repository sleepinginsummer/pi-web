import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { fetchSessionContext, invalidateSessionContext, resetSessionContextCacheForTests } = await createJiti(import.meta.url).import("./session-load-client.ts");

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
test.afterEach(() => resetSessionContextCacheForTests());

test("context 客户端统一传递 leaf 与 defer 参数", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      context: { messages: [{ role: "user", content: "hi" }], entryIds: ["u1"], oldestEntryId: "u1", hasMore: false, thinkingLevel: "off", model: null },
      leafId: "leaf-1",
      version: "v1",
    }));
  };

  const result = await fetchSessionContext("session/1", new AbortController().signal, { leafId: "leaf-1" });
  assert.equal(result.kind, "loaded");
  assert.match(requestedUrl, /session%2F1\/context/);
  assert.match(requestedUrl, /leafId=leaf-1/);
  assert.match(requestedUrl, /deferThinking=1/);
  assert.match(requestedUrl, /deferMedia=1/);
});

test("context 客户端传递 tail 与 before 分页参数并绕过缓存", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: "v1",
    }));
  };

  await fetchSessionContext("sid", new AbortController().signal, {
    before: "entry-50",
    tail: 25,
    skipCache: true,
  });
  assert.match(requestedUrl, /before=entry-50/);
  assert.match(requestedUrl, /tail=25/);
  assert.doesNotMatch(requestedUrl, /messageLimit=/);
});

test("context 客户端拒绝 messages 与 entryIds 错位", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    context: { messages: [{ role: "user", content: "hi" }], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
    leafId: null,
    version: "v1",
  }));
  await assert.rejects(
    fetchSessionContext("sid", new AbortController().signal),
    /messages 与 entryIds 长度不一致/,
  );
});

test("普通上下文加载会写入缓存，并在失效后重新请求", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: `v${requests}`,
    }));
  };

  const first = await fetchSessionContext("cached", new AbortController().signal);
  const second = await fetchSessionContext("cached", new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(first.kind === "loaded" && first.cached, false);
  assert.equal(second.kind === "loaded" && second.cached, true);

  invalidateSessionContext("cached");
  const third = await fetchSessionContext("cached", new AbortController().signal);
  assert.equal(requests, 2);
  assert.equal(third.kind === "loaded" && third.snapshot.version, "v2");
});

test("同一会话的并发普通读取共享一次网络请求", async () => {
  let requests = 0;
  let release;
  globalThis.fetch = async () => {
    requests += 1;
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: "shared-v1",
    }));
  };

  const first = fetchSessionContext("shared", new AbortController().signal);
  const second = fetchSessionContext("shared", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release();
  await Promise.all([first, second]);
});

test("缓存复验使用 ETag，版本未变化时不重新传输上下文", async () => {
  let requests = 0;
  let revalidateHeaders;
  globalThis.fetch = async (_url, init) => {
    requests += 1;
    if (requests === 2) {
      revalidateHeaders = init?.headers;
      return new Response(null, { status: 304 });
    }
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: "etag-v1",
    }));
  };

  await fetchSessionContext("etag", new AbortController().signal);
  const revalidated = await fetchSessionContext("etag", new AbortController().signal, { skipCache: true });
  assert.equal(revalidated.kind === "loaded" && revalidated.snapshot.version, "etag-v1");
  assert.deepEqual(revalidateHeaders, { "If-None-Match": '"etag-v1"' });
});
