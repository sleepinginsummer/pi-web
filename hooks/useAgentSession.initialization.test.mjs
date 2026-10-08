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
  const connect = new Function(
    "useCallback", "EventSource", "eventStreamConnectionRef", "eventSourceRef", "closeEvents",
    "EVENT_STREAM_CONNECT_TIMEOUT_MS", "fetchRuntimeState", "applyRuntimeState",
    "sessionIdRef", "handleAgentEventRef", "agentRunningRef",
    `${compiled}\nreturn connectEvents;`,
  )(
    (callback) => callback, FakeEventSource, connectionRef, eventSourceRef, closeEvents,
    1000, async () => ({ state: undefined }), () => {},
    { current: "session-1" }, { current: null }, { current: false },
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
