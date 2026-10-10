// Integration check for the exact condition app/api/sessions/[id]/route.ts
// branches on: a live wrapper's SessionManager does NOT know an entry that
// another process appended to the same file. This validates the SDK contract
// (`getEntry()` is backed by an in-memory index, not a disk read) that the
// external-writer detection depends on — issue #632.
import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// jiti 编译后的实现通过 require 调用 fs，所以要用同一个可变模块对象才能观察到读取行为。
const fsModule = createRequire(import.meta.url)("node:fs");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { readLatestSessionEntryId } = await jiti.import("./session-reader.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { writeSessionInfoThroughLiveSession } = await jiti.import("./session-info-writer.ts");
const { SessionDiskInspector } = await jiti.import("./session-disk-freshness.ts");

const header = {
  type: "session",
  version: 3,
  id: "11111111-1111-4111-8111-111111111111",
  cwd: "/tmp",
  timestamp: "2026-01-01T00:00:00.000Z",
};
function entry(id, text) {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-eviction-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(
    dir,
    "2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl",
  );
  writeFileSync(
    file,
    `${JSON.stringify(header)}\n${JSON.stringify(entry("aaaa1111", "first"))}\n`,
  );
  return file;
}

test("an externally appended entry is unknown to the in-memory manager", (t) => {
  const file = fixture(t);
  const manager = SessionManager.open(file);
  assert.ok(
    manager.getEntry("aaaa1111"),
    "precondition: manager knows its own entry",
  );

  // Simulate the pi TUI appending to the same session file.
  appendFileSync(
    file,
    `${JSON.stringify(entry("bbbb2222", "written by the other process"))}\n`,
  );

  const diskLatestId = readLatestSessionEntryId(file);
  assert.equal(diskLatestId, "bbbb2222");
  // This is the branch condition: unknown disk id => the wrapper is stale.
  assert.equal(manager.getEntry(diskLatestId), undefined);
});

function makeIdleWrapper(file, knownIds, overrides = {}) {
  const known = new Set(knownIds);
  return new AgentSessionWrapper({
    sessionId: "11111111-1111-4111-8111-111111111111",
    sessionFile: file,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    sessionManager: {
      getCwd: () => "/tmp",
      getEntry: (id) => known.has(id) ? { id } : undefined,
      getHeader: () => header,
      getEntries: () => knownIds.map((id) => entry(id, id === "aaaa1111" ? "first" : id)),
    },
    agent: { state: {} },
    dispose() {},
    ...overrides,
  });
}

test("evictIfDiskAhead drops an idle wrapper when disk has an unknown entry", (t) => {
  const file = fixture(t);
  appendFileSync(
    file,
    `${JSON.stringify(entry("bbbb2222", "written by the other process"))}\n`,
  );
  const wrapper = makeIdleWrapper(file, ["aaaa1111"]);
  t.after(() => wrapper.destroy());
  assert.equal(wrapper.evictIfDiskAhead(), true);
  assert.equal(wrapper.isAlive(), false);
});

test("evictIfDiskAhead leaves a running wrapper alone", (t) => {
  const file = fixture(t);
  appendFileSync(
    file,
    `${JSON.stringify(entry("bbbb2222", "written by the other process"))}\n`,
  );
  const wrapper = makeIdleWrapper(file, ["aaaa1111"], { isStreaming: true });
  t.after(() => wrapper.destroy());
  assert.equal(wrapper.evictIfDiskAhead(), false);
  assert.equal(wrapper.isAlive(), true);
});

test("a manager writing its own entries is never flagged as stale", (t) => {
  // The eviction must not fire on pi-web's own appends, or every read would
  // destroy a healthy wrapper in a loop.
  const file = fixture(t);
  const manager = SessionManager.open(file);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "written by pi-web" }],
  });

  const diskLatestId = readLatestSessionEntryId(file);
  assert.ok(diskLatestId, "pi-web's own append must be visible on disk");
  assert.ok(
    manager.getEntry(diskLatestId),
    "and must already be known to the manager",
  );
});

test("运行中的 wrapper 检测到外部写入但不能销毁", (t) => {
  const file = fixture(t);
  const wrapper = makeIdleWrapper(file, ["aaaa1111"], { isStreaming: true });
  t.after(() => wrapper.destroy());
  appendFileSync(file, `${JSON.stringify(entry("external", "another process"))}\n`);
  assert.equal(wrapper.diskFreshness(), "changed");
  assert.equal(wrapper.evictIfDiskAhead(), false);
  assert.equal(wrapper.isAlive(), true);
});

test("运行中外部写入仍允许 Stop，但拒绝继续修改会话", async (t) => {
  const file = fixture(t);
  const manager = SessionManager.open(file);
  let aborts = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: header.id,
    sessionFile: file,
    isStreaming: true,
    isBashRunning: false,
    isCompacting: false,
    sessionManager: manager,
    agent: { state: {} },
    abort: async () => { aborts += 1; },
    dispose() {},
  });
  t.after(() => wrapper.destroy());
  appendFileSync(file, `${JSON.stringify(entry("external", "other process"))}\n`);
  await wrapper.send({ type: "abort" });
  assert.equal(aborts, 1);
  await assert.rejects(wrapper.send({ type: "set_thinking_level", level: "high" }), /会话文件已被外部修改/);
});

test("冷启动加载期间的外部写入在第一次命令派发前被拒绝", async (t) => {
  const file = fixture(t);
  const manager = SessionManager.open(file);
  appendFileSync(file, `${JSON.stringify(entry("after-open", "written during startup"))}\n`);
  let dispatched = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: header.id, sessionFile: file,
    isStreaming: false, isBashRunning: false, isCompacting: false,
    sessionManager: manager, agent: { state: {} },
    setThinkingLevel: () => { dispatched = true; }, dispose() {},
  }, new Set(), "initial", { persistedSessionFile: true });
  t.after(() => wrapper.destroy());
  await assert.rejects(wrapper.send({ type: "set_thinking_level", level: "high" }), /会话文件已被外部修改/);
  assert.equal(dispatched, false);
});

/** 把 wrapper 放进 rpc-manager 的注册表，让 session_info 写入边界能按文件路径找到它。 */
function registerWrapper(t, file, manager) {
  const wrapper = new AgentSessionWrapper({
    sessionId: header.id,
    sessionFile: file,
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    sessionManager: manager,
    agent: { state: {} },
    dispose() {},
  });
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[header.id, wrapper]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    wrapper.destroy();
  });
  return wrapper;
}

test("pi-web 自己的标题写入走存活 wrapper，写后仍是最新", (t) => {
  // 文件级独立 SessionManager 追加 session_info 会让 wrapper 内存少一条记录，
  // 运行中的会话随后每个 /context 都 409。写入必须复用 wrapper 自己的 SessionManager。
  const file = fixture(t);
  const manager = SessionManager.open(file);
  const wrapper = registerWrapper(t, file, manager);
  assert.equal(wrapper.diskFreshness(), "current", "precondition: 内存与磁盘一致");

  assert.equal(writeSessionInfoThroughLiveSession(file, "新标题", { requireName: null }), "written");
  assert.equal(manager.getSessionName(), "新标题", "内存里必须能看到这条 entry");
  assert.match(readFileSync(file, "utf8"), /"name":"新标题"/, "磁盘上必须有这条 entry");
  assert.equal(wrapper.diskFreshness(), "current", "自己的写入不能被判成外部修改");
  assert.equal(wrapper.evictIfDiskAhead(), false, "自己的写入不能触发淘汰");
});

test("没有存活 wrapper 时回退文件级写入，名称基线不匹配时放弃写入", (t) => {
  const file = fixture(t);
  assert.equal(writeSessionInfoThroughLiveSession(file, "标题"), "no-live-session");

  const manager = SessionManager.open(file);
  registerWrapper(t, file, manager);
  // 任务开始后名称被手动改过：异步生成的结果不能覆盖，且不能退回文件级写入。
  assert.equal(writeSessionInfoThroughLiveSession(file, "过期标题", { requireName: "另一个名字" }), "stale");
  assert.equal(manager.getSessionName(), undefined);
  assert.doesNotMatch(readFileSync(file, "utf8"), /session_info/);
});

test("会话身份不匹配时按路径命中的 wrapper 不算命中", (t) => {
  // 路径缓存过期时同一路径可能指向别的会话：那时必须回退文件级写入，
  // 不能把内容追加到另一个会话的内存里。
  const file = fixture(t);
  const manager = SessionManager.open(file);
  registerWrapper(t, file, manager);
  assert.equal(writeSessionInfoThroughLiveSession(file, "标题", { sessionId: "other-session" }), "no-live-session");
  assert.equal(manager.getSessionName(), undefined);
  assert.equal(writeSessionInfoThroughLiveSession(file, "标题", { sessionId: header.id }), "written");
  assert.equal(manager.getSessionName(), "标题");
});

/**
 * 增量路径只对超过 2MB 的文件启用，所以 fixture 首条 entry 必须够大；
 * 让它占满文件头部，后面的原地改写就落在「EOF 前 64KB」窗口之外。
 */
function largeFixture(t, { withExtra = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-append-only-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
  const bigEntry = entry("hhhh0001", `start-${"h".repeat(3_000_000)}-end`);
  const secondEntry = entry("hhhh0002", "second");
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(bigEntry)}\n${JSON.stringify(secondEntry)}\n`);
  const manager = SessionManager.open(file);
  const wrapper = registerWrapper(t, file, manager);
  if (withExtra) {
    // 内存与磁盘同时追加：这是运行中 wrapper 每次落盘的正常形态。
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "appended by pi-web" }] });
  }
  return { file, manager, wrapper };
}

test("自己的追加走增量核对，判定仍然是最新", (t) => {
  const { file, manager, wrapper } = largeFixture(t, { withExtra: true });
  assert.equal(wrapper.diskFreshness(), "current");
  // 基线已经全量核对过：这次追加只该读新增字节，不能再读整个文件。
  const originalReadFileSync = fsModule.readFileSync;
  let fullReads = 0;
  fsModule.readFileSync = (...args) => {
    fullReads += 1;
    return originalReadFileSync(...args);
  };
  t.after(() => { fsModule.readFileSync = originalReadFileSync; });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "next turn" }] });
  assert.equal(wrapper.diskFreshness(), "current");
  assert.equal(fullReads, 0, "增量核对不应该重新读整个文件");
  assert.match(readFileSync(file, "utf8"), /next turn/);
});

test("窗口内的原地改写配合同一次追加必须判 changed", (t) => {
  const { file, manager, wrapper } = largeFixture(t, { withExtra: true });
  assert.equal(wrapper.diskFreshness(), "current");
  // 追加让文件变长（尾部与内存逐条一致），同时改写落在 EOF 前 64KB 窗口里；
  // 只看尾部会误判 current，所以窗口比对是增量路径的必需条件。
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "next turn" }] });
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("\"second\""), "precondition: 被改写的字段是短 entry 的正文");
  writeFileSync(file, text.replace("\"second\"", "\"SECOND\""));
  assert.equal(wrapper.diskFreshness(), "changed");
});

test("增量核对要求 inode 与外层一致，截断时退回全量", (t) => {
  const { file, wrapper } = largeFixture(t);
  assert.equal(wrapper.diskFreshness(), "current");
  // 截断到只剩 header：变短不能走增量路径，全量核对会看到内存多出来的 entry。
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  assert.equal(wrapper.diskFreshness(), "changed");
});

test("追加内容与内存不一致时判 changed，而不是退回全量", (t) => {
  const { file, wrapper } = largeFixture(t);
  assert.equal(wrapper.diskFreshness(), "current");
  // 外部进程追加：尾部对不上内存，必须判 changed。
  appendFileSync(file, `${JSON.stringify(entry("external", "from another process"))}\n`);
  assert.equal(wrapper.diskFreshness(), "changed");
});

test("追加写入未完成时判 unstable，等下一次请求", (t) => {
  const { file, wrapper } = largeFixture(t);
  assert.equal(wrapper.diskFreshness(), "current");
  // 半行写入：不能当成内容错误，也不能当成最新。
  appendFileSync(file, JSON.stringify(entry("half", "no newline yet")));
  assert.equal(wrapper.diskFreshness(), "unstable");
});

test("前缀之外的原地改写必须在有限次追加内被重新核对", (t) => {
  const { file, manager, wrapper } = largeFixture(t);
  assert.equal(wrapper.diskFreshness(), "current");
  // 文件头部被原地改写（在 EOF 前 64KB 窗口之外），同时内存与磁盘一起追加一大段匹配内容。
  const text = readFileSync(file, "utf8");
  assert.ok(text.indexOf("start-") < 1024, "precondition: 被改写的字段在文件头部");
  writeFileSync(file, text.replace("start-", "START-"));
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] });
  assert.equal(wrapper.diskFreshness(), "changed");
});

test("超过前缀核对时限后必须重新核对完整前缀", async (t) => {
  const { file, manager } = largeFixture(t);
  const inspector = new SessionDiskInspector(manager, true, { maxDeferredPrefixMs: 20 });
  assert.equal(inspector.inspect(file), "current");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace("start-", "START-"));
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "tiny" }] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(inspector.inspect(file), "changed");
});

test("增量核对之后不再追加，超过时限也要重新核对旧前缀", async (t) => {
  // 版本缓存不能盖过时间预算：增量成功登记后如果不再写入，版本会一直命中，
  // 旧前缀必须靠预算到期强制重新核对，否则改写会永远漏检。
  const { file, manager } = largeFixture(t);
  const inspector = new SessionDiskInspector(manager, true, { maxDeferredPrefixMs: 30 });
  assert.equal(inspector.inspect(file), "current");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace("start-", "START-"));
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "tiny" }] });
  // 这一次走增量路径：窗口之外的改写此刻还看不到。
  assert.equal(inspector.inspect(file), "current");
  // 之后不再追加；超过时间预算后即使版本没变也必须回到全量。
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(inspector.inspect(file), "changed");
});

test("为确认前缀保留的字节不会连整个文件一起驻留", (t) => {
  const { file, manager } = largeFixture(t);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  assert.ok(inspector.retainedPrefixBytes() <= 64 * 1024, `全量核对后保留了 ${inspector.retainedPrefixBytes()} 字节`);
  // 追加一大段之后再走增量路径，同样不能把这次的缓冲区一起留下。
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "y".repeat(3_000_000) }] });
  assert.equal(inspector.inspect(file), "current");
  assert.ok(inspector.retainedPrefixBytes() <= 64 * 1024, `增量核对后保留了 ${inspector.retainedPrefixBytes()} 字节`);
});

test("外部手工改名后，自动命名不再覆盖用户名称", (t) => {
  const file = fixture(t);
  const manager = SessionManager.open(file);
  registerWrapper(t, file, manager);
  assert.equal(manager.getSessionName(), undefined, "precondition: 任务开始时还没有名称");

  // 任务开始后，另一个 SessionManager（外部进程/另一个窗口）写入了用户的手动改名。
  SessionManager.open(file).appendSessionInfo("用户手动名");

  // 自动命名必须放弃：内存里的名称基线已经过期，用它判定会把用户的名字覆盖掉。
  assert.equal(
    writeSessionInfoThroughLiveSession(file, "自动生成的标题", { sessionId: header.id, requireName: null }),
    "stale",
  );
  const contents = readFileSync(file, "utf8");
  assert.match(contents, /用户手动名/);
  assert.doesNotMatch(contents, /自动生成的标题/);
});

test("热更新前创建的旧 wrapper 也能写入 session_info", (t) => {
  // 旧实例没有 AgentSessionWrapper.appendSessionInfoName：直接用它的 SessionManager 追加，
  // 否则热更新后旧会话的自动命名和重命名都会抛 TypeError。
  const file = fixture(t);
  const appended = [];
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[header.id, {
    isAlive: () => true,
    sessionFile: file,
    sessionId: header.id,
    diskFreshness: () => "current",
    inner: {
      sessionManager: {
        getSessionName: () => undefined,
        appendSessionInfo: (name) => appended.push(name),
      },
    },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  assert.equal(
    writeSessionInfoThroughLiveSession(file, "旧实例写入的标题", { sessionId: header.id, requireName: null }),
    "written",
  );
  assert.deepEqual(appended, ["旧实例写入的标题"]);
});
