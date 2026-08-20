import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function transpileDataUrl(fileName, replacements = []) {
  let source = fs.readFileSync(new URL(fileName, import.meta.url), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const eventsUrl = transpileDataUrl("./session-title-events.ts");
const clientUrl = transpileDataUrl("./session-title-operation-client.ts", [
  ['"./session-title-events"', JSON.stringify(eventsUrl)],
]);
const { runSessionTitleOperation } = await import(clientUrl);

class FakeEventSource {
  onmessage = null;
  onerror = null;
  closed = false;

  emit(event) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  fail() {
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const SESSION_ID = "session-1";
const OPERATION_ID = "12345678-1234-4123-8123-123456789abc";
const OTHER_OPERATION_ID = "87654321-4321-4321-8321-cba987654321";

test("标题操作忽略其它 operationId 和不完整事件，只接收自己的完整终态", async () => {
  const source = new FakeEventSource();
  let request;
  const operation = runSessionTitleOperation({
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    createEventSource: () => source,
    fetchFn: async (_url, init) => {
      request = init;
      return {
        ok: true,
        status: 202,
        json: async () => ({ status: "accepted", operationId: OPERATION_ID }),
      };
    },
    timeoutMs: 1_000,
  });

  source.emit({ type: "connected", sessionId: SESSION_ID });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(request.body), { operationId: OPERATION_ID });

  source.emit({
    type: "session_title_error",
    sessionId: SESSION_ID,
    operationId: OTHER_OPERATION_ID,
    error: "其它请求失败",
  });
  source.emit({
    type: "session_title_updated",
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
  });
  source.emit({
    type: "session_title_updated",
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    title: "当前请求标题",
  });

  assert.equal(await operation, "当前请求标题");
  assert.equal(source.closed, true);
});

test("标题操作只接收同一会话的错误事件", async () => {
  const source = new FakeEventSource();
  const operation = runSessionTitleOperation({
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    createEventSource: () => source,
    fetchFn: async () => ({
      ok: true,
      status: 202,
      json: async () => ({ status: "accepted", operationId: OPERATION_ID }),
    }),
    timeoutMs: 1_000,
  });

  source.emit({ type: "connected", sessionId: SESSION_ID });
  await Promise.resolve();
  source.emit({
    type: "session_title_error",
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    error: "生成失败",
  });

  await assert.rejects(operation, /生成失败/);
  assert.equal(source.closed, true);
});

test("POST 挂起时统一截止时间会 abort 请求并关闭 SSE", async () => {
  const source = new FakeEventSource();
  let requestSignal;
  const operation = runSessionTitleOperation({
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    createEventSource: () => source,
    fetchFn: async (_url, init) => {
      requestSignal = init.signal;
      return await new Promise(() => {});
    },
    timeoutMs: 20,
  });

  source.emit({ type: "connected", sessionId: SESSION_ID });
  await assert.rejects(operation, /operation timed out/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(source.closed, true);
});

test("POST 挂起后 SSE 断开会立即 abort 请求并关闭连接", async () => {
  const source = new FakeEventSource();
  let requestSignal;
  const operation = runSessionTitleOperation({
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    createEventSource: () => source,
    fetchFn: async (_url, init) => {
      requestSignal = init.signal;
      return await new Promise(() => {});
    },
    timeoutMs: 10_000,
  });

  source.emit({ type: "connected", sessionId: SESSION_ID });
  await Promise.resolve();
  source.fail();
  await assert.rejects(operation, /event stream disconnected/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(source.closed, true);
});

test("合法终态先到后 SSE 断开，POST 随后返回仍成功", async () => {
  const source = new FakeEventSource();
  const response = deferred();
  let requestSignal;
  const operation = runSessionTitleOperation({
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    createEventSource: () => source,
    fetchFn: async (_url, init) => await new Promise((resolve, reject) => {
      requestSignal = init.signal;
      response.promise.then(resolve);
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason ?? new Error("fetch aborted"));
      }, { once: true });
    }),
    timeoutMs: 1_000,
  });

  source.emit({ type: "connected", sessionId: SESSION_ID });
  await Promise.resolve();
  source.emit({
    type: "session_title_updated",
    sessionId: SESSION_ID,
    operationId: OPERATION_ID,
    title: "已生成标题",
  });
  source.fail();
  assert.equal(requestSignal.aborted, false);
  response.resolve({
    ok: true,
    status: 202,
    json: async () => ({ status: "accepted", operationId: OPERATION_ID }),
  });

  assert.equal(await operation, "已生成标题");
  assert.equal(source.closed, true);
});
