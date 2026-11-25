import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// 独立进程与临时 agent 目录，只创建空会话，不调用真实模型或修改用户数据。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-team-edit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const runtime = await jiti.import("./team-runtime.ts");
const store = await jiti.import("./teams.ts");
const addons = await jiti.import("./system-prompt-addon.ts");
const reader = await jiti.import("./session-reader.ts");

test("编辑团队实际创建新会话，清理旧角色提示词并保留旧会话，失败不残留孤立会话", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-cwd-"));
  const config = { model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "low" };
  const team = await runtime.provisionTeam({ name: "原团队", cwd, leaderPrompt: "原 leader 职责", ...config });
  const dev = await runtime.provisionTeamMember({ teamId: team.id, name: "dev", prompt: "原开发职责", ...config });
  const oldLeader = team.members[0];
  const oldFiles = await Promise.all([oldLeader, dev].map((member) => reader.resolveSessionPath(member.sessionId)));
  assert.ok(oldFiles.every((path) => path && existsSync(path)));
  const current = store.getTeam(team.id);
  const input = { name: "新团队", prompt: "新目标", cwd, leaderName: "new-leader", leaderPrompt: "新职责", expectedUpdatedAt: current.updatedAt, ...config };
  const rebuilt = await runtime.rebuildTeamWithCleanup(team.id, input);
  assert.equal(rebuilt.members.length, 1);
  assert.notEqual(rebuilt.members[0].sessionId, oldLeader.sessionId);
  assert.equal(rebuilt.members[0].name, "new-leader");
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
  await assert.rejects(runtime.rebuildTeamWithCleanup(team.id, { ...input, expectedUpdatedAt: rebuilt.updatedAt, leaderName: "all" }), /保留字/);
  assert.deepEqual(readdirSync(join(agentDir, "sessions"), { recursive: true }).sort(), before);
  assert.deepEqual(store.getTeam(team.id), rebuilt);
});

test("团队重建接口必须明确确认，拒绝过期版本，并返回新团队快照", async () => {
  const { POST } = await jiti.import("../app/api/teams/[id]/route.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-team-api-"));
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
  const response = await submit({ ...input, confirmRebuild: true });
  assert.equal(response.status, 200);
  const { team: updated } = await response.json();
  assert.equal(updated.name, "已编辑");
  assert.equal(updated.members[0].title, "", "允许清空职位");
  assert.notEqual(updated.members[0].sessionId, team.members[0].sessionId);
  assert.deepEqual(store.getTeam(team.id), updated);
});
