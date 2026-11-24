/**
 * pi-web 同源 SSE broker 的纯逻辑（无 port / 无网络），供 SharedWorker 与单元测试共用。
 *
 * 关键约束：经典 worker 不能 import ESM，因此这里把纯函数挂到 `self` 上，
 * 由 public/sse-broker.js 通过 importScripts 加载；Node 测试同样用 vm 加载本文件。
 */
(function (scope) {
  "use strict";

  /**
   * 增量 SSE 解析器：一次 push 可能收到半帧，也可能一次收到多帧。
   * 只做协议层解析（event / data / 注释），不理解任何业务负载。
   */
  function createSseParser(onFrame) {
    let buffer = "";
    let name = null;
    let data = "";

    function flushFrame() {
      // 没有任何字段的帧（例如 ": ping" 心跳产生的空帧）不产生事件。
      if (name === null && data === "") return;
      const frame = { name, data: data.endsWith("\n") ? data.slice(0, -1) : data };
      name = null;
      data = "";
      onFrame(frame);
    }

    return {
      push(chunk) {
        buffer += chunk;
        for (;;) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd < 0) return;
          let line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          // 兼容 CRLF：SSE 允许行尾 \r\n。
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            flushFrame();
            continue;
          }
          if (line.startsWith(":")) continue; // 注释/心跳
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") name = value;
          else if (field === "data") data += `${value}\n`;
          // 其余字段（id / retry）当前不需要：broker 自己管重连节奏。
        }
      },
    };
  }

  /**
   * 一次解析就绪和不可重试的启动失败；命名 connected 与会话 data: connected 都表示就绪。
   * 普通高频帧只解析一次，避免为了两个控制分支重复构造大对象。
   */
  function classifyConnectionFrame(frame) {
    if (frame.name === "connected") return "ready";
    if (frame.name !== null || !frame.data) return null;
    try {
      const event = JSON.parse(frame.data);
      if (event.type === "connected") return "ready";
      if (event.type === "startup_error" && event.retryable === false) return "failed";
      return null;
    } catch {
      return null;
    }
  }

  function isConnectedFrame(frame) {
    return classifyConnectionFrame(frame) === "ready";
  }

  /** 重连退避：失败后翻倍，成功连接后重置。 */
  function nextRetryDelay(previousMs, baseMs, maxMs) {
    if (!previousMs || previousMs <= 0) return baseMs;
    return Math.min(previousMs * 2, maxMs);
  }

  scope.piWebSseBrokerCore = { createSseParser, isConnectedFrame, classifyConnectionFrame, nextRetryDelay };
})(typeof self !== "undefined" ? self : globalThis);
