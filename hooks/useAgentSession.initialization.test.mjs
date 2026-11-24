import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("并发初始化复用 SSE，断线和显式关闭后重新建立连接", async () => {
  const connector = source.slice(source.indexOf("const connectEvents = useCallback"), source.indexOf("const ensureEventsConnected = useCallback"));
  const compiled = ts.transpileModule(connector, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const sources = [];
  let noticeSequence = 0;
  class FakeEventSource {
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = FakeEventSource.CLOSED; }
    connected() {
      this.readyState = FakeEventSource.OPEN;
      this.onmessage({ data: JSON.stringify({ type: "connected" }) });
    }
  }
  const eventSourceRef = { current: null };
  const connectionRef = { current: null };
  const closeEvents = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    connectionRef.current = null;
  };
  // 长连接构造已收敛到 broker 门面（不可用时它自己退回直连），这里注入等价实现。
  const connect = new Function(
    "useCallback", "EventSource", "createStreamSource", "STREAM_OPEN", "STREAM_CLOSED",
    "eventStreamConnectionRef", "eventSourceRef", "closeEvents", "eventStreamStartupFailureRef",
    "eventStreamRetryNoticeRef", "createNoticeId",
    "EVENT_STREAM_CONNECT_TIMEOUT_MS", "fetchRuntimeState", "applyRuntimeState", "beginRuntimeRead", "applyRuntimeSnapshot",
    "sessionIdRef", "handleAgentEventRef", "agentRunningRef", "addNotice", "translateRef",
    `${compiled}\nreturn connectEvents;`,
  )(
    (callback) => callback, FakeEventSource, (url) => new FakeEventSource(url),
    FakeEventSource.OPEN, FakeEventSource.CLOSED,
    connectionRef, eventSourceRef, closeEvents, { current: null },
    { current: null }, () => `retry-${++noticeSequence}`,
    1000, async () => ({ state: undefined }), () => {},
    // 建连补读走统一坐标：这里只需要它被调用，投影本身由 applyRuntimeSnapshot 覆盖。
    () => ({ seq: 1, queueGeneration: 0, compactionEpoch: 0, thinkingRevision: 0 }),
    () => {},
    { current: "session-1" }, { current: null }, { current: false },
    // 启动失败的提示与文案只影响界面，这里只保证它们可被调用。
    () => {}, { current: (key) => key },
  );
  try {
    const first = connect("session-1");
    assert.equal(connect("session-1"), first);
    assert.equal(sources.length, 1);
    sources[0].connected();
    assert.equal((await first).status, "connected");
    assert.equal(connect("session-1"), first);
    sources[0].readyState = 0;
    const reconnecting = connect("session-1");
    assert.notEqual(reconnecting, first, "断线后不能复用已完成的 connected 结果");
    sources[1].connected();
    await reconnecting;
    closeEvents();
    const second = connect("session-1");
    assert.notEqual(second, first);
    assert.equal(sources.length, 3);
    sources[2].connected();
    await second;
  } finally { closeEvents(); }
});
