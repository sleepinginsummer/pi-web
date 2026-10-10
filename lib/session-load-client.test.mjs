import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { fetchSessionContext, invalidateSessionContext, pruneSessionContextCache, resetSessionContextCacheForTests } = await createJiti(import.meta.url).import("./session-load-client.ts");
const { isSessionExternalWriteError } = await createJiti(import.meta.url).import("./session-external-write.ts");

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

test("列表清理使尚未完成的已删除会话请求失效", async () => {
  let requests = 0;
  let release;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: `pruned-v${requests}`,
    }));
  };

  const stale = fetchSessionContext("removed", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  pruneSessionContextCache([]);
  release();
  await stale;

  const fresh = await fetchSessionContext("removed", new AbortController().signal);
  assert.equal(requests, 2);
  assert.equal(fresh.kind === "loaded" && fresh.snapshot.version, "pruned-v2");
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

test("会话文件写入冲突自动重试一次，成功则正常返回", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(
        JSON.stringify({ error: "会话文件正在被外部修改，请等待写入完成后刷新", code: "session_external_write" }),
        { status: 409 },
      );
    }
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: "retry-v1",
    }));
  };

  const result = await fetchSessionContext("conflict-retry", new AbortController().signal, { skipCache: true });
  assert.equal(requests, 2);
  assert.equal(result.kind === "loaded" && result.snapshot.version, "retry-v1");
});

test("重试后仍冲突时抛出可恢复错误，而不是内容错误", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(
      JSON.stringify({ error: "会话文件正在被外部修改，请等待写入完成后刷新", code: "session_external_write" }),
      { status: 409 },
    );
  };

  await assert.rejects(
    fetchSessionContext("conflict-fatal", new AbortController().signal, { skipCache: true }),
    (error) => {
      assert.ok(isSessionExternalWriteError(error));
      assert.match(error.message, /正在被外部修改/);
      return true;
    },
  );
  assert.equal(requests, 2);
});

test("共享请求的重试不被单个调用方的取消打断", async () => {
  // 可缓存读取由多个调用方共用一次请求：一个人切走不能把别人的重试一起取消。
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(
        JSON.stringify({ error: "会话文件正在被外部修改，请等待写入完成后刷新", code: "session_external_write" }),
        { status: 409 },
      );
    }
    return new Response(JSON.stringify({
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      leafId: null,
      version: "shared-v2",
    }));
  };

  const first = new AbortController();
  const second = new AbortController();
  const consumers = Promise.allSettled([
    fetchSessionContext("shared-conflict", first.signal),
    fetchSessionContext("shared-conflict", second.signal),
  ]);
  // 首个请求已经发出，此时取消第一个调用方（模拟会话切换/组件卸载）。
  await new Promise((resolve) => setTimeout(resolve, 10));
  first.abort();

  const [cancelled, survivor] = await consumers;
  assert.equal(cancelled.status, "rejected");
  assert.equal(cancelled.reason?.name, "AbortError");
  assert.equal(survivor.status, "fulfilled", `第二个调用方收到 ${survivor.status}`);
  assert.equal(survivor.value.kind === "loaded" && survivor.value.snapshot.version, "shared-v2");
  assert.equal(requests, 2, "重试必须真的发生");
});
