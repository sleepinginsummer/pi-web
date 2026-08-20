import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { fetchSessionDetails, fetchRuntimeState } = await createJiti(import.meta.url).import("./session-load-client.ts");
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

test("details 与 runtime state 使用独立请求端点和信号", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal });
    if (String(url).endsWith("/details")) {
      return new Response(JSON.stringify({ sessionId: "sid", filePath: "/tmp/s.jsonl", tree: [], leafId: null }));
    }
    return new Response(JSON.stringify({ alive: false, busy: false }));
  };
  const detailsController = new AbortController();
  const runtimeController = new AbortController();

  await Promise.all([
    fetchSessionDetails("sid", detailsController.signal),
    fetchRuntimeState("sid", runtimeController.signal),
  ]);

  assert.equal(calls[0].url, "/api/sessions/sid/details");
  assert.equal(calls[0].signal, detailsController.signal);
  assert.equal(calls[1].url, "/api/sessions/sid/state");
  assert.equal(calls[1].signal, runtimeController.signal);
});

test("取消 details 不会取消独立的 runtime state", async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/details")) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return new Response(JSON.stringify({ alive: true, busy: false }));
  };
  const detailsController = new AbortController();
  const runtimeController = new AbortController();
  const details = fetchSessionDetails("sid", detailsController.signal);
  const runtime = fetchRuntimeState("sid", runtimeController.signal);
  detailsController.abort();

  await assert.rejects(details, { name: "AbortError" });
  assert.equal((await runtime).alive, true);
  assert.equal(runtimeController.signal.aborted, false);
});
