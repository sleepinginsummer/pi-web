import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const browseSnapshot = await readFile(new URL("../../../lib/session-browse-snapshot.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE: deleteSession, GET: getSessionDetail, PATCH: renameSession } = await jiti.import("./[id]/route.ts");
const { GET: getSessionList } = await jiti.import("./route.ts");
const { GET: getRunningSessions } = await jiti.import("../agent/running/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const {
  cacheSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
} = await jiti.import("../../../lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("list versions expose idle session creation, rename and deletion to other windows", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-list-sync-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (sessionId) invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const list = async () => {
    const response = await getSessionList(new Request("http://localhost/api/sessions"));
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await list();
  assert.deepEqual(initial.sessions, []);

  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "Cross-window search fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Already finished" }], timestamp: Date.now() });
  sessionId = manager.getSessionId();
  invalidateSessionListCache();
  const created = await list();
  assert.ok(created.sessionListVersion > initial.sessionListVersion);
  assert.equal(created.sessions[0].id, sessionId);
  assert.deepEqual(created.runningSessionIds, []);

  const context = { params: Promise.resolve({ id: sessionId }) };
  const url = `http://localhost/api/sessions/${sessionId}`;
  const renamed = await renameSession(new Request(url, { method: "PATCH", body: JSON.stringify({ name: "Renamed elsewhere" }) }), context);
  assert.equal(renamed.status, 200);
  const poll = await (await getRunningSessions()).json();
  assert.deepEqual(poll.runningSessionIds, []);
  assert.ok(poll.sessionListVersion > created.sessionListVersion);
  const updated = await list();
  assert.equal(updated.sessionListVersion, poll.sessionListVersion);
  assert.equal(updated.sessions[0].name, "Renamed elsewhere");
  assert.equal((await list()).sessionListVersion, poll.sessionListVersion, "reads must not create a refresh loop");

  assert.equal((await deleteSession(new Request(url, { method: "DELETE" }), context)).status, 200);
  const deleted = await list();
  assert.ok(deleted.sessionListVersion > updated.sessionListVersion);
  assert.deepEqual(deleted.sessions, []);
  assert.equal((await (await getRunningSessions()).json()).sessionListVersion, deleted.sessionListVersion);
});

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  const liveLookup = browseSnapshot.indexOf("getRpcSession(sessionId)");
  const pathLookup = browseSnapshot.indexOf("resolveSessionPath(sessionId)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(detailRoute, /getRpcSession\(id\)/);
  assert.match(contextRoute, /readSessionBrowseSnapshot\(id\)/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSessionSnapshot(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(snapshot\.alive\)/);
});

test("删除中间子代理时将后代一同移入回收站", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-reparent-"));
  const grandparentPath = join(dir, "grandparent.jsonl");
  const parentPath = join(dir, "parent.jsonl");
  const childPath = join(dir, "child.jsonl");
  const parentId = "delete-reparent-parent";
  const header = (id, parentSession) => JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    ...(parentSession ? { parentSession } : {}),
  });
  await writeFile(grandparentPath, `${header("delete-reparent-grandparent")}\n`);
  await writeFile(parentPath, `${header(parentId, grandparentPath)}\n`);
  await writeFile(childPath, [
    header("delete-reparent-child", parentPath),
    JSON.stringify({
      type: "custom",
      customType: "pi-web:subagent",
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: parentId,
        parentSessionPath: parentPath,
        profile: "Explore",
        description: "Inspect parser",
      },
    }),
    "",
  ].join("\n"));
  cacheSessionPath(parentId, parentPath);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    invalidateSessionPathCache(parentId);
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );

  assert.equal(response.status, 200);
  await assert.rejects(readFile(parentPath), { code: "ENOENT" });
  await assert.rejects(readFile(childPath), { code: "ENOENT" });
  assert.ok((await readdir(join(dir, "trash"))).some((name) => name.endsWith("_child.jsonl")));
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.equal(detail.info.projectRoot, "/tmp");
  assert.equal(typeof detail.info.projectKey, "string");
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    alive: true,
    busy: true,
    state: { isStreaming: true },
  });
});

test("重命名通过存活 wrapper 写入，不回退文件级 SessionManager", async (t) => {
  // 文件级独立 SessionManager 追加重命名会让 wrapper 内存少一条记录，
  // 运行中的会话随后会被判成“外部修改”。用不存在的文件路径保证回退路径必然失败。
  const previousRegistry = globalThis.__piSessions;
  const id = "live-rename-test";
  const filePath = join(tmpdir(), `pi-web-live-rename-not-persisted-${process.pid}.jsonl`);
  const appended = [];
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    sessionFile: filePath,
    sessionId: id,
    // 内存与磁盘一致才允许走 wrapper 写入。
    diskFreshness: () => "current",
    inner: { sessionManager: { getSessionName: () => undefined } },
    appendSessionInfoName: (name) => appended.push(name),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    invalidateSessionPathCache(id);
  });
  cacheSessionPath(id, filePath);

  const response = await renameSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name: "活的会话" }) }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(appended, ["活的会话"]);
});

test("wrapper 已落后磁盘时，显式重命名退回文件级写入", async (t) => {
  // 落后于磁盘的 wrapper 内存里是过期内容：显式重命名必须仍然生效，
  // 但只能写文件，不能把名字追加到过期内容后面，它会在下次读取时被淘汰重建。
  const dir = await mkdtemp(join(tmpdir(), "pi-web-rename-stale-"));
  const id = "stale-rename-test";
  const filePath = join(dir, "stale.jsonl");
  await writeFile(filePath, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir })}\n`);
  const previousRegistry = globalThis.__piSessions;
  const appendedToWrapper = [];
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    sessionFile: filePath,
    sessionId: id,
    diskFreshness: () => "changed",
    inner: { sessionManager: { getSessionName: () => undefined } },
    appendSessionInfoName: (name) => appendedToWrapper.push(name),
  }]]);
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
  });
  cacheSessionPath(id, filePath);

  const response = await renameSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name: "仍然生效" }) }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(appendedToWrapper, [], "落后的 wrapper 不能被写入");
  assert.match(await readFile(filePath, "utf8"), /仍然生效/);
});

test("删除父会话时，仍存活的分叉会话不再被判成外部修改", async (t) => {
  // 级联改写用 writeFileSync 绕开 wrapper，改的是文件头。存活 wrapper 必须登记这次改写，
  // 否则正在运行的分叉会话会把自己人写的文件判成外部修改并一直 409。
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-adopt-"));
  const childPath = join(dir, "child.jsonl");
  const parentPath = join(dir, "parent.jsonl");
  const childId = "delete-adopt-child";
  const parentId = "delete-adopt-parent";
  const header = (id, parentSession) => JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    ...(parentSession ? { parentSession } : {}),
  });
  const entry = {
    type: "message",
    id: "child-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "forked turn" },
  };
  await writeFile(parentPath, `${header(parentId)}\n`);
  await writeFile(childPath, `${header(childId, parentPath)}\n${JSON.stringify(entry)}\n`);

  const { AgentSessionWrapper } = await jiti.import("../../../lib/rpc-manager.ts");
  const manager = SessionManager.open(childPath);
  const wrapper = new AgentSessionWrapper({
    sessionId: childId,
    sessionFile: childPath,
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    sessionManager: manager,
    agent: { state: {} },
    dispose() {},
  });
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[childId, wrapper]]);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  cacheSessionPath(parentId, parentPath);
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    invalidateSessionPathCache(parentId);
    wrapper.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(wrapper.diskFreshness(), "current", "precondition: 改写前一致");

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );

  assert.equal(response.status, 200);
  const childHeader = JSON.parse((await readFile(childPath, "utf8")).split("\n")[0]);
  assert.equal("parentSession" in childHeader, false, "级联改写确实去掉了父会话");
  assert.equal(wrapper.diskFreshness(), "current", "存活 wrapper 必须认识这次改写");
});
