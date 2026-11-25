import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 独立进程与临时 agent 目录，只创建空会话，不调用真实模型或修改用户数据。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-team-edit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const runtime = await jiti.import("./team-runtime.ts");
const store = await jiti.import("./teams.ts");
const addons = await jiti.import("./system-prompt-addon.ts");
const reader = await jiti.import("./session-reader.ts");
const { getAllowedFileRoots } = await jiti.import("./file-access.ts");
const { getAdditionalAllowedRoots, normalizeSlashes } = await jiti.import("./allowed-roots.ts");
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

async function waitForStagedAddon(directory, previousCount) {
  const deadline = Date.now() + 1_000;
  while (readdirSync(directory).length === previousCount && Date.now() < deadline) await delay(10);
  assert.equal(readdirSync(directory).length, previousCount + 1);
}

test("编辑团队实际创建新会话，清理旧角色提示词并保留旧会话，失败不残留孤立会话", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-cwd-"));
  const newCwd = mkdtempSync(join(tmpdir(), "pi-web-team-rebuild-cwd-"));
  const rejectedCwd = mkdtempSync(join(tmpdir(), "pi-web-team-rejected-cwd-"));
  for (const directory of [cwd, newCwd, rejectedCwd]) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "low" };
  const team = await runtime.provisionTeam({ name: "原团队", cwd, leaderPrompt: "原 leader 职责", ...config });
  const dev = await runtime.provisionTeamMember({ teamId: team.id, name: "dev", prompt: "原开发职责", ...config });
  const oldLeader = team.members[0];
  const oldFiles = await Promise.all([oldLeader, dev].map((member) => reader.resolveSessionPath(member.sessionId)));
  assert.ok(oldFiles.every((path) => path && existsSync(path)));
  const current = store.getTeam(team.id);
  const input = { name: "新团队", prompt: "新目标", cwd: newCwd, leaderName: "new-leader", leaderPrompt: "新职责", expectedUpdatedAt: current.updatedAt, ...config };
  const rebuilt = await runtime.rebuildTeamWithCleanup(team.id, input);
  assert.equal(rebuilt.members.length, 1);
  assert.notEqual(rebuilt.members[0].sessionId, oldLeader.sessionId);
  assert.equal(rebuilt.members[0].name, "new-leader");
  assert.equal(rebuilt.members[0].cwd, newCwd);
  assert.ok(await reader.resolveSessionPath(rebuilt.members[0].sessionId));
  const row = (await reader.listAllSessions({ force: true })).find((item) => item.id === rebuilt.members[0].sessionId);
  assert.equal(row?.requiresTeamRebuildCommit, true);
  assert.ok(store.readCommittedTeamRebuildSessions().has(row.id));
  assert.ok((await getAllowedFileRoots()).has(normalizeSlashes(newCwd)));
  assert.equal(store.findMembershipBySession(dev.sessionId), undefined);
  assert.ok(oldFiles.every((path) => existsSync(path)), "旧会话保留为普通会话");
  const addonFiles = readdirSync(join(agentDir, "pi-web-system-prompt-addon-sessions"));
  assert.ok(addonFiles.length > 0);
  // 通过公开读取接口确认旧职责已经失效，新职责已写入新会话。
  assert.equal(addons.readSessionSystemPromptAddon(oldLeader.sessionId), null);
  assert.equal(addons.readSessionSystemPromptAddon(dev.sessionId), null);
  assert.equal(addons.readSessionSystemPromptAddon(rebuilt.members[0].sessionId).text, "新职责");
  const before = readdirSync(join(agentDir, "sessions"), { recursive: true }).sort();
  await assert.rejects(runtime.rebuildTeamWithCleanup(team.id, input), store.TeamEditConflictError);
  await assert.rejects(runtime.rebuildTeamWithCleanup(team.id, { ...input, cwd: rejectedCwd, expectedUpdatedAt: rebuilt.updatedAt, leaderName: "all" }), /保留字/);
  assert.equal((await getAllowedFileRoots()).has(normalizeSlashes(rejectedCwd)), false);
  assert.deepEqual(readdirSync(join(agentDir, "sessions"), { recursive: true }).sort(), before);
  assert.deepEqual(store.getTeam(team.id), rebuilt);
});

test("团队重建接口必须明确确认，拒绝过期版本，并返回新团队快照", async (t) => {
  const { POST } = await jiti.import("../app/api/teams/[id]/route.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-api-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const team = await runtime.provisionTeam({ name: "接口测试", cwd, model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "low" });
  const { DEFAULT_TEAM_LEADER_PROMPT } = await jiti.import("./team-types.ts");
  assert.equal(team.members[0].prompt, DEFAULT_TEAM_LEADER_PROMPT);
  assert.equal(addons.readSessionSystemPromptAddon(team.members[0].sessionId).text, DEFAULT_TEAM_LEADER_PROMPT);
  const submit = (body) => POST(new Request("http://localhost/api/teams/" + team.id, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: team.id }) });
  const input = { name: "已编辑", cwd, prompt: "", leaderPrompt: "", leaderTitle: "", expectedUpdatedAt: team.updatedAt };
  assert.equal((await submit(input)).status, 400);
  assert.deepEqual(store.getTeam(team.id), team, "没有确认不能修改团队");
  assert.equal((await submit({ ...input, confirmRebuild: true, expectedUpdatedAt: 0 })).status, 409);
  assert.equal((await submit({ ...input, confirmRebuild: true, thinkingLevel: "invalid" })).status, 400);
  await store.createTeamCard(team.id, { title: "保留指派", assignee: team.members[0].name }, "user");
  const before = store.getTeam(team.id);
  const filesBefore = readdirSync(join(agentDir, "sessions"), { recursive: true }).sort();
  const existingFile = join(cwd, "not-a-directory.txt");
  writeFileSync(existingFile, "fixture");
  const invalidCwd = await submit({ ...input, cwd: existingFile, expectedUpdatedAt: before.updatedAt, confirmRebuild: true });
  assert.equal(invalidCwd.status, 400);
  assert.match((await invalidCwd.json()).error, /工作目录必须是目录/);
  assert.deepEqual(store.getTeam(team.id), before);
  assert.deepEqual(readdirSync(join(agentDir, "sessions"), { recursive: true }).sort(), filesBefore);
  const response = await submit({ ...input, expectedUpdatedAt: before.updatedAt, confirmRebuild: true });
  assert.equal(response.status, 200);
  const { team: updated } = await response.json();
  assert.equal(updated.name, "已编辑");
  assert.equal(updated.members[0].title, "", "允许清空职位");
  assert.notEqual(updated.members[0].sessionId, team.members[0].sessionId);
  assert.deepEqual(store.getTeam(team.id), updated);
});

test("并发重建等待版本复查时不发布新会话，冲突后不留下目录授权", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-conflict-"));
  const newCwd = mkdtempSync(join(tmpdir(), "pi-web-team-pending-"));
  for (const directory of [cwd, newCwd]) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "low" };
  const team = await runtime.provisionTeam({ name: "并发团队", cwd, ...config });
  const sessionsDir = join(agentDir, "sessions");
  const addonsDir = join(agentDir, "pi-web-system-prompt-addon-sessions");
  const originalFiles = readdirSync(sessionsDir, { recursive: true }).sort();
  const originalAddons = readdirSync(addonsDir).sort();
  const locked = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  const concurrent = store.rebuildTeam(team.id, {
    name: "先提交的更改", leader: team.members[0], expectedUpdatedAt: team.updatedAt,
  }, undefined, {
    aroundSave: async (_previous, commit) => {
      locked.resolve();
      await unblock.promise;
      commit();
    },
  });
  await locked.promise;
  const rejected = assert.rejects(runtime.rebuildTeamWithCleanup(team.id, {
    name: "过期的更改", cwd: newCwd, expectedUpdatedAt: team.updatedAt, ...config,
  }), store.TeamEditConflictError);
  // 按快照文件确认待重建请求已准备完毕，并且正等待团队锁。
  let waitingFiles;
  let waitingRoots;
  try {
    await waitForStagedAddon(addonsDir, originalAddons.length);
    waitingFiles = readdirSync(sessionsDir, { recursive: true }).sort();
    waitingRoots = getAdditionalAllowedRoots().has(normalizeSlashes(newCwd));
  } finally {
    unblock.resolve();
    await Promise.all([concurrent, rejected]);
  }
  assert.deepEqual(waitingFiles, originalFiles);
  assert.equal(waitingRoots, false);
  assert.deepEqual(readdirSync(addonsDir).sort(), originalAddons);
  assert.equal((await getAllowedFileRoots()).has(normalizeSlashes(newCwd)), false);
});

test("其他进程只为已提交的团队重建会话授权，脱离团队后仍可访问", { timeout: 45_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-committed-"));
  const newCwd = mkdtempSync(join(tmpdir(), "pi-web-team-staged-"));
  for (const directory of [cwd, newCwd]) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const team = await runtime.provisionTeam({ name: "提交前", cwd });
  // 留下一份真实扫描可见的待提交会话，模拟写完 JSONL 但尚未提交团队时的磁盘状态。
  const manager = SessionManager.create(newCwd);
  const id = manager.getSessionId();
  writeFileSync(manager.getSessionFile(), JSON.stringify({
    ...manager.getHeader(), requiresTeamRebuildCommit: true,
  }) + "\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from "jiti";
    import { join } from "node:path";
    const jiti = createJiti(join(process.cwd(), "package.json"), { tsconfigPaths: true });
    const { getAllowedFileRoots, normalizeSlashes } = await jiti.import("./lib/file-access.ts");
    process.on("message", async () => {
      // 只跳过五秒权限缓存，保留另一进程实际已扫描的会话缓存。
      globalThis.__piAllowedRootsCache = undefined;
      const roots = await getAllowedFileRoots();
      process.send(process.argv.slice(1).map((cwd) => roots.has(normalizeSlashes(cwd))));
    });
  `, cwd, newCwd], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => child.kill());
  async function readInOtherProcess() {
    const reply = once(child, "message", { signal: AbortSignal.timeout(30_000) });
    child.send("read");
    const [roots] = await reply;
    return roots;
  }
  assert.deepEqual(await readInOtherProcess(), [true, false]);

  await store.rebuildTeam(team.id, {
    name: "已提交", expectedUpdatedAt: team.updatedAt,
    leader: { sessionId: id, name: "leader", cwd: newCwd },
  });
  assert.deepEqual(await readInOtherProcess(), [true, true]);
  await runtime.disbandTeamWithCleanup(team.id);
  assert.deepEqual(await readInOtherProcess(), [true, true]);
});

test("提示词锁等待期间目录被替换时保留原团队与指派", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-keep-"));
  const newCwd = mkdtempSync(join(tmpdir(), "pi-web-team-removed-cwd-"));
  for (const directory of [cwd, newCwd]) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "low" };
  const team = await runtime.provisionTeam({ name: "保留团队", cwd, leaderPrompt: "原职责", ...config });
  const leader = team.members[0];
  await store.createTeamCard(team.id, { title: "保留卡片", assignee: leader.name }, "user");
  const original = store.getTeam(team.id);
  const sessionsDir = join(agentDir, "sessions");
  const addonsDir = join(agentDir, "pi-web-system-prompt-addon-sessions");
  const originalFiles = readdirSync(sessionsDir, { recursive: true }).sort();
  const originalAddons = readdirSync(addonsDir).sort();
  const locked = Promise.withResolvers();
  const release = Promise.withResolvers();
  const holding = addons.withSessionSystemPromptAddonLock(leader.sessionId, () => {
    locked.resolve();
    return release.promise;
  });
  await locked.promise;
  // 锁目录可能同时出现在快照目录里，取锁后再计数。
  const addonCountWithLock = readdirSync(addonsDir).length;
  const rebuild = assert.rejects(runtime.rebuildTeamWithCleanup(team.id, {
    name: "应被拒绝", cwd: newCwd, expectedUpdatedAt: original.updatedAt, ...config,
  }), /工作目录必须是目录/);
  try {
    await waitForStagedAddon(addonsDir, addonCountWithLock);
    rmSync(newCwd, { recursive: true });
    writeFileSync(newCwd, "路径已改成普通文件");
  } finally {
    release.resolve();
    await Promise.all([holding, rebuild]);
  }
  assert.deepEqual(store.getTeam(team.id), original);
  assert.equal(addons.readSessionSystemPromptAddon(leader.sessionId).text, "原职责");
  assert.deepEqual(readdirSync(sessionsDir, { recursive: true }).sort(), originalFiles);
  assert.deepEqual(readdirSync(addonsDir).sort(), originalAddons);
  assert.equal((await getAllowedFileRoots()).has(normalizeSlashes(newCwd)), false);
});
