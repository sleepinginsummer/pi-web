import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { createTerminalWriter, terminalRequest } from "../lib/terminal-client.ts";

test("terminal errors preserve server diagnostics and explain non-JSON responses", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const body of [null, "<html>Server error</html>", "null"]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status: 500 }));
    await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ error: "Native module missing; run npm rebuild node-pty" }, { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /Native module missing; run npm rebuild node-pty/);
});

test("a delayed input request cannot be overtaken by typing or resize", async (t) => {
  const received = [];
  let finishFirst;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    if (received.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("a");
  writer.resize(100, 30);
  writer.write("b\r");
  await setImmediate();
  assert.equal(received.length, 1);
  finishFirst();
  await setImmediate();
  assert.deepEqual(received, [
    { type: "input", data: "a" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "b\r" },
  ]);
  await writer.stop();
});

test("large Unicode pastes preserve characters while bounding input requests", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).data);
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
  writer.write(text);
  await setImmediate();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  await writer.stop();
});

test("typing during a slow request is batched into the next ordered write", async (t) => {
  const received = [];
  let release;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body).data);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("first");
  await setImmediate();
  for (const character of "a long command\r") writer.write(character);
  assert.deepEqual(received, ["first"]);
  release();
  await setImmediate();
  assert.deepEqual(received, ["first", "a long command\r"]);
  await writer.stop();
});

test("failed or stopped delivery discards queued input without retrying commands", async (t) => {
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "gone" }, { status: 404 }));
  const writer = createTerminalWriter("id", (error) => errors.push(error.message));
  writer.write("first");
  writer.write("second");
  await setImmediate();
  assert.deepEqual(errors, ["gone"]);
  assert.equal(fetch.mock.callCount(), 1);
  await writer.stop();
  writer.write("third");
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
});

const panelSource = await readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8");

test("终端先取得连接额度再创建 PTY（排队超过无监听回收期限会丢进程）", () => {
  const waitIndex = panelSource.indexOf("const grantedNow = await waitForTerminalSlot();");
  const createIndex = panelSource.indexOf('await terminalRequest("/api/terminal", {');
  assert.ok(waitIndex >= 0, "必须先等待额度");
  assert.ok(createIndex > waitIndex, "创建 PTY 之前必须已经拿到额度");
  assert.match(panelSource, /ptyStarted = true;\n\s+connect\(\);/);
});

test("后台/离线恢复时作废旧许可，许可被收回要断开已有连接", () => {
  const pageHide = panelSource.slice(panelSource.indexOf("const pageHide = () => {"), panelSource.indexOf("const pageShow ="));
  assert.match(pageHide, /invalidateTerminalSlot\(\)/, "页面离开必须作废本地许可，恢复后等重新授予");
  const applyGrant = panelSource.slice(panelSource.indexOf("const applyGrant ="), panelSource.indexOf("const acquireTerminalSlot ="));
  assert.match(applyGrant, /granted >= 1/, "拿到额度才建连");
  assert.match(applyGrant, /events\?\.close\(\)/, "许可被收回时必须关闭已有连接");
});

test("等待额度必须可取消，离线恢复后能继续启动", () => {
  const waitBlock = panelSource.slice(panelSource.indexOf("const waitForTerminalSlot"), panelSource.indexOf("const invalidateTerminalSlot"));
  assert.match(waitBlock, /new Promise<boolean>/, "等待要能返回取消结果");
  assert.match(waitBlock, /slotWaiter = \{ settle: resolve \}/, "等待者必须被保存以便收敛");

  const invalidate = panelSource.slice(panelSource.indexOf("const invalidateTerminalSlot"), panelSource.indexOf("cancelSlotWaitRef.current"));
  assert.match(invalidate, /settleSlotWait\(false\)/, "作废许可时必须取消在途等待，而不是丢弃回调");

  const startup = panelSource.slice(panelSource.indexOf("while (!disposed && !exited && !startupAborted)"), panelSource.indexOf('if (restored || reconnectKey > 0)'));
  assert.match(startup, /await waitForTerminalSlot\(\)/, "启动必须等待额度");
  assert.match(startup, /await waitForResume\(\)/, "被取消后要等恢复事件继续，而不是永久卡住");
  assert.match(startup, /if \(disposed \|\| exited \|\| startupAborted\) return;/, "关闭/失效后不得继续启动");
});

test("已连接终端关闭后，迟到的恢复事件与额度回执都不得再建连", () => {
  const openStreamBlock = panelSource.slice(panelSource.indexOf("const openStream = () =>"), panelSource.indexOf("const closeStream"));
  assert.match(openStreamBlock, /startupAborted/, "openStream 必须受终止标志约束");
  const connectBlock = panelSource.slice(panelSource.indexOf("const connect = () =>"), panelSource.indexOf("startRef.current ="));
  assert.match(connectBlock, /startupAborted/, "connect 必须受终止标志约束（online/pageshow 都走它）");
  const grantBlock = panelSource.slice(panelSource.indexOf("const applyGrant ="), panelSource.indexOf("const acquireTerminalSlot ="));
  assert.match(grantBlock, /if \(startupAborted\) return;/, "关闭后不得再处理额度回执");
  // 终止标志必须早于回调声明，否则同步路径会踩 TDZ。
  assert.ok(
    panelSource.indexOf("let startupAborted = false;") < panelSource.indexOf("const applyGrant ="),
    "终止标志必须先声明",
  );
});

test("关闭时先关闭连接再归还额度（顺序反了会让预算低估真实连接）", () => {
  const cancelBlock = panelSource.slice(panelSource.indexOf("cancelSlotWaitRef.current = () =>"), panelSource.indexOf("let offset: number | undefined;"));
  const closeIndex = cancelBlock.indexOf("events?.close();");
  const releaseIndex = cancelBlock.indexOf("releaseTerminalSlot();");
  assert.ok(closeIndex >= 0 && releaseIndex > closeIndex, "必须先关连接，再归还额度");
  assert.match(cancelBlock, /events = null;/, "本地连接状态要一起清掉");
  assert.match(cancelBlock, /streaming = false;/, "连接状态标记要复位");
  assert.match(cancelBlock, /terminal\.options\.disableStdin = true;/, "先停输入");
});

test("关闭必须终止启动流程（不是暂停），之后不得再创建 PTY", () => {
  const cancelBlock = panelSource.slice(panelSource.indexOf("cancelSlotWaitRef.current = () =>"), panelSource.indexOf("let offset: number | undefined;"));
  assert.match(cancelBlock, /startupAborted = true;/, "关闭必须把启动流程标记为终止");
  assert.match(cancelBlock, /settleSlotWait\(false\)/, "在途额度等待必须立刻结束");
  assert.match(cancelBlock, /cancelResumeWait\?\.\(\)/, "在途恢复等待必须立刻结束，否则关闭会被挂住");
  assert.match(panelSource, /if \(disposed \|\| exited \|\| startupAborted\) return;\n\s+ptyStarted = true;/, "终止后不得创建 PTY");
});

test("关闭面板先取消额度申请，再清理已创建的 PTY", () => {
  const closeEffect = panelSource.slice(panelSource.indexOf("if (!tab.closing) return;"), panelSource.indexOf("return () => { cancelled = true; }"));
  const cancelIndex = closeEffect.indexOf("cancelSlotWaitRef.current();");
  const awaitIndex = closeEffect.indexOf("await startRef.current;");
  assert.ok(cancelIndex >= 0 && awaitIndex > cancelIndex, "必须先取消在途等待，避免关闭被额度等待挂住");
  assert.match(closeEffect, /terminalRequest\(`\/api\/terminal/, "随后才做实际清理");
});

