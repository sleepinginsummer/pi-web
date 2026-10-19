import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { fetchSessionContext, invalidateSessionContext, resetSessionContextCacheForTests } = await jiti.import("../lib/session-load-client.ts");
const { deleteSessionViewSnapshot } = await jiti.import("../lib/session-view-cache.ts");
const originalFetch = globalThis.fetch;

test.after(() => { globalThis.fetch = originalFetch; });
test.afterEach(() => resetSessionContextCacheForTests());

// 执行真实的压缩后加载入口，网络与上下文缓存继续使用生产实现。
function createCompactionLoader(onLoaded) {
  const callbackSource = source.slice(
    source.indexOf("const loadCompactedSession = useCallback"),
    source.indexOf("const loadContext = useCallback"),
  );
  const compiled = ts.transpileModule(callbackSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const loadSession = async (sid, showLoading = false, includeState = false, options = {}) => {
    const result = await fetchSessionContext(sid, new AbortController().signal, { skipCache: options.validateView });
    onLoaded(result, { showLoading, includeState, ...options });
    return { loaded: result.kind === "loaded", agentState: null };
  };
  return new Function(
    "useCallback", "loadSession", "invalidateSessionContext", "deleteSessionViewSnapshot",
    `${compiled}\nreturn loadCompactedSession;`,
  )((callback) => callback, loadSession, invalidateSessionContext, deleteSessionViewSnapshot);
}

function contextPayload(compacted) {
  const messages = compacted
    ? [{ role: "custom", customType: "compaction", display: true, content: "本次压缩" }]
    : [{ role: "user", content: "压缩前的消息" }];
  const entryId = compacted ? "new-compaction" : "old-user";
  return {
    context: { messages, entryIds: [entryId], oldestEntryId: entryId, hasMore: false, thinkingLevel: "off", model: null },
    leafId: entryId,
    version: compacted ? "after-compaction" : "before-compaction",
  };
}

test("手动压缩完成后首个提交就是新上下文，并请求定位本次卡片", async () => {
  let compacted = false;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json(contextPayload(compacted));
  };
  await fetchSessionContext("cached-session", new AbortController().signal);
  compacted = true;
  const commits = [];
  const loadCompactedSession = createCompactionLoader((result, options) => commits.push({ result, options }));

  await loadCompactedSession("cached-session", true);

  assert.equal(requests, 2);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].result.snapshot.version, "after-compaction");
  assert.equal(commits[0].result.snapshot.messages[0].customType, "compaction");
  assert.equal(commits[0].options.focusCompaction, true);
});

test("压缩前尚未完成的预取不能被复用，也不能覆盖压缩后的缓存", async () => {
  let requests = 0;
  let releaseOld;
  globalThis.fetch = async () => {
    requests += 1;
    const isOld = requests === 1;
    if (isOld) await new Promise((resolve) => { releaseOld = resolve; });
    return Response.json(contextPayload(!isOld));
  };
  const prefetch = fetchSessionContext("inflight-session", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  const commits = [];
  const loadCompactedSession = createCompactionLoader((result) => commits.push(result));
  const reload = loadCompactedSession("inflight-session", true);
  await new Promise((resolve) => setImmediate(resolve));
  releaseOld();
  await Promise.all([prefetch, reload]);

  assert.equal(commits[0].snapshot.version, "after-compaction");
  const cached = await fetchSessionContext("inflight-session", new AbortController().signal);
  assert.equal(cached.snapshot.version, "after-compaction");
  assert.equal(requests, 2);
});

test("自动压缩也读取新上下文，但不强制移动用户的阅读位置", async () => {
  globalThis.fetch = async () => Response.json(contextPayload(true));
  let loadedOptions;
  const loadCompactedSession = createCompactionLoader((_result, options) => { loadedOptions = options; });

  await loadCompactedSession("auto-session");

  assert.equal(loadedOptions.validateView, true);
  assert.equal(loadedOptions.focusCompaction, false);
});

test("SSE 手动压缩完成保留卡片定位，自动压缩不抢位置", () => {
  const eventBranch = source.slice(
    source.indexOf('case "auto_compaction_end":'),
    source.indexOf('case "extension_ui_request":'),
  );
  const calls = [];
  const handleEvent = new Function(
    "event", "sessionIdRef", "loadCompactedSession", "setIsCompacting", "setCompactError", "setCompactResult", "readCompactResult",
    ts.transpileModule(`switch (event.type) { ${eventBranch} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  for (const reason of ["manual", "auto"]) {
    handleEvent(
      { type: "compaction_end", reason, aborted: false }, { current: "session" },
      (...args) => calls.push(args), () => {}, () => {}, () => {}, () => null,
    );
  }
  assert.deepEqual(calls, [["session", true], ["session", false]]);
});
