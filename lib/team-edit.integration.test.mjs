import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

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
    const deadline = Date.now() + 1_000;
    while (readdirSync(addonsDir).length === originalAddons.length && Date.now() < deadline) await delay(10);
    assert.equal(readdirSync(addonsDir).length, originalAddons.length + 1);
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
