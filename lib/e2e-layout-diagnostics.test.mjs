import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { geometry, withLayoutDiagnostics, prewarmLayoutEventStream } from "../e2e/responsive-layout.mjs";

// 手动推进浏览器帧，确定性地在两次采样之间移除节点，无需等待真实页面抖动。
function sampler() {
  const frames = [];
  const state = { missing: null, frame: 0, rectError: null, jitter: false };
  const rect = () => {
    if (state.rectError) throw state.rectError;
    const x = state.jitter ? state.frame % 2 : 0;
    return { x, y: 0, width: 300, height: 80, bottom: 80, right: x + 300 };
  };
  const elements = {
    ".composer-card": { getBoundingClientRect: rect },
    ".chat-window": { getBoundingClientRect: rect },
  };
  const input = {
    getBoundingClientRect: rect,
    closest: selector => state.missing === selector ? null : elements[selector],
  };
  const document = {
    querySelector: () => state.missing === ".chat-input-textarea" ? null : input,
    activeElement: input,
    documentElement: { scrollWidth: 320 },
  };
  const page = {
    evaluate: fn => runInNewContext(`(${fn.toString()})()`, {
      document, innerWidth: 320, visualViewport: { height: 320 }, scrollX: 0, scrollY: 0,
      requestAnimationFrame: callback => frames.push(callback),
    }),
  };
  const advance = () => { state.frame++; frames.shift()(); };
  const flush = () => {
    for (let i = 0; i < 200 && frames.length; i++) advance();
  };
  return { page, state, advance, flush };
}

for (const selector of [".chat-input-textarea", ".composer-card", ".chat-window"]) {
  test(`采样中途缺少 ${selector} 时立即拒绝并标明节点`, { timeout: 2000 }, async () => {
    const sample = sampler();
    const rejected = assert.rejects(geometry(sample.page), { message: `布局采样缺少元素：${selector}` });
    sample.state.missing = selector;
    sample.advance();
    await rejected;
  });
}

test("后续帧中的测量异常也交给外层失败处理", { timeout: 2000 }, async () => {
  const sample = sampler();
  const original = new Error("测量失败");
  const rejected = assert.rejects(geometry(sample.page), error => error === original);
  sample.state.rectError = original;
  sample.advance();
  await rejected;
});

test("稳定布局仍能完成采样", async () => {
  const sample = sampler();
  const pending = geometry(sample.page);
  sample.flush();
  const result = await pending;
  assert.equal(result.focused, true);
  assert.equal(result.input.height, 80);
});

test("持续跳变仍受帧数上限约束", { timeout: 2000 }, async () => {
  const sample = sampler();
  sample.state.jitter = true;
  const rejected = assert.rejects(geometry(sample.page), /布局持续跳变/);
  sample.flush();
  await rejected;
});


for (const [screenshotFails, traceFails] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`诊断采集不覆盖原始错误：截图失败=${screenshotFails}，trace 失败=${traceFails}`, async t => {
    const original = new Error("原始布局断言失败");
    const attempts = [];
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    const page = { screenshot: async () => {
      attempts.push("screenshot");
      if (screenshotFails) throw new Error("截图超时或页面已关闭");
    } };
    const context = {
      tracing: { stop: async () => {
        attempts.push("trace");
        if (traceFails) throw new Error("trace 采集失败");
      } },
      close: async () => attempts.push("close"),
    };
    await assert.rejects(withLayoutDiagnostics({ page, context, artifacts: "/tmp", tag: "failure" }, async () => {
      throw original;
    }), error => error === original);
    assert.deepEqual(attempts, ["screenshot", "trace", "close"]);
    assert.equal(logs.length, Number(screenshotFails) + Number(traceFails));
    if (screenshotFails) assert.ok(logs.some(args => String(args[0]).includes("保存截图失败")));
    if (traceFails) assert.ok(logs.some(args => String(args[0]).includes("保存trace失败")));
  });
}

test("关闭上下文失败也不覆盖原始用例错误", async t => {
  const original = new Error("原始用例错误");
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  await assert.rejects(withLayoutDiagnostics({
    page: { screenshot: async () => {} },
    context: { tracing: { stop: async () => {} }, close: async () => { throw new Error("浏览器已断开"); } },
    artifacts: "/tmp", tag: "closed",
  }, async () => { throw original; }), error => error === original);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][0]), /关闭浏览器上下文失败/);
});

test("成功用例照常返回并关闭上下文", async () => {
  let closed = false;
  const result = await withLayoutDiagnostics({ context: { close: async () => { closed = true; } } }, async () => "完成");
  assert.equal(result, "完成");
  assert.equal(closed, true);
});

test("成功用例的关闭失败仍应报错", async () => {
  const error = new Error("关闭失败");
  await assert.rejects(withLayoutDiagnostics({ context: { close: async () => { throw error; } } }, async () => {}), value => value === error);
});


function mockPrewarmStream(t, text, { status = 200, bytewise = false } = {}) {
  const bytes = new TextEncoder().encode(text);
  const chunks = bytewise ? Array.from(bytes, byte => Uint8Array.of(byte)) : [bytes];
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } }), { status });
  });
  return () => assert.equal(signal.aborted, true, "预热结束后必须关闭连接");
}

test("预热保留逐字节到达的启动错误及会话 ID", async t => {
  const sessionId = "layout-startup-split";
  const message = "扩展启动失败：无法加载 /fixture/extension.ts";
  const checkClosed = mockPrewarmStream(t, `data: ${JSON.stringify({ type: "startup_error", errorMessage: message })}\n\n`, { bytewise: true });
  await assert.rejects(prewarmLayoutEventStream("http://fixture", sessionId), error =>
    error.message.includes(sessionId) && error.message.includes(message));
  checkClosed();
});

test("预热按完整 SSE 事件解析 CRLF、多行 data 和心跳", async t => {
  const sessionId = "layout-startup-multiline";
  const message = "Agent 初始化失败：缺少模型配置";
  const checkClosed = mockPrewarmStream(t, `: heartbeat\r\n\r\ndata: {"type":"heartbeat"}\r\n\r\ndata: {"type":"startup_error",\r\ndata: "errorMessage":${JSON.stringify(message)}}\r\n\r\n`, { bytewise: true });
  await assert.rejects(prewarmLayoutEventStream("http://fixture", sessionId), error =>
    error.message.includes(sessionId) && error.message.includes(message));
  checkClosed();
});

test("预热完整收到 connected 后正常结束并关闭连接", async t => {
  const checkClosed = mockPrewarmStream(t, ': heartbeat\n\ndata: {"type":"heartbeat"}\n\ndata: {"type":"connected"}\n\n', { bytewise: true });
  await prewarmLayoutEventStream("http://fixture", "layout-connected");
  checkClosed();
});

test("缺少 SSE 空行边界时不能提前宣告 connected", async t => {
  const sessionId = "layout-incomplete";
  const checkClosed = mockPrewarmStream(t, 'data: {"type":"connected"}');
  await assert.rejects(prewarmLayoutEventStream("http://fixture", sessionId), error => error.message.includes(sessionId));
  checkClosed();
});

test("预热 HTTP 失败也保留会话 ID 并关闭连接", async t => {
  const sessionId = "layout-http-error";
  const checkClosed = mockPrewarmStream(t, "不可用", { status: 503 });
  await assert.rejects(prewarmLayoutEventStream("http://fixture", sessionId), error => error.message.includes(sessionId));
  checkClosed();
});


for (const bytewise of [false, true]) {
  test(`预热以首个就绪帧为准，不因后续数据的分块改变结果：bytewise=${bytewise}`, async t => {
    const checkClosed = mockPrewarmStream(t, 'data: {"type":"connected"}\n\ndata: {"type":"startup_error","errorMessage":"后续数据"}\n\n', { bytewise });
    await prewarmLayoutEventStream("http://fixture", "layout-ready");
    checkClosed();
  });
}
