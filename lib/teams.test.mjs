import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./teams.ts");
const ext = await jiti.import("./team-extension.ts");
const wakeTypes = await jiti.import("./wake-message-types.ts");

function tempStore() {
  return join(mkdtempSync(join(tmpdir(), "pi-web-teams-")), "teams.json");
}

test("team CRUD, member uniqueness, leader protection, and corrupt recovery", async () => {
  const path = tempStore();
  const team = await store.createTeam({
    name: "支付重构组",
    prompt: "完成退款与对账重构",
    leader: { sessionId: "s-leader", name: "leader", title: "架构师", prompt: "拆解任务并把控质量", cwd: "/repo" },
  }, 1000, path);

  assert.equal(team.members.length, 1);
  assert.equal(team.members[0].role, "leader");
  assert.equal(store.findMembershipBySession("s-leader", path)?.team.id, team.id);

  // 重名与保留字拒绝
  await assert.rejects(
    store.addTeamMember(team.id, { sessionId: "s-dup", name: "LEADER", cwd: "/repo" }, 1001, path),
    /已有名为/,
  );
  await assert.rejects(
    store.addTeamMember(team.id, { sessionId: "s-res", name: "all", cwd: "/repo" }, 1001, path),
    /保留字/,
  );

  const dev = await store.addTeamMember(team.id, { sessionId: "s-dev1", name: "dev-1", title: "后端开发", cwd: "/repo-api" }, 1002, path);
  const rev = await store.addTeamMember(team.id, { sessionId: "s-rev1", name: "review-1", title: "代码审核", cwd: "/repo-api" }, 1003, path);

  // Leader 不能被移除
  await assert.rejects(store.removeTeamMember(team.id, team.members[0].id, 1004, path), /leader/);

  // 活动记录
  assert.equal(await store.recordMemberActivity("s-dev1", "完成退款接口", 1005, path), true);
  assert.equal(store.getTeam(team.id, path).members.find((m) => m.id === dev.id).lastActivity.summary, "完成退款接口");

  // 只读路径发现损坏时不写盘，避免在锁外覆盖其他进程写入；持锁写入时才备份并从空恢复
  writeFileSync(path, "{broken json");
  assert.deepEqual(store.listTeams(path), []);
  assert.equal(readdirSync(join(path, "..")).some((f) => f.startsWith("teams.json.corrupt-")), false);
  const recreated = await store.createTeam({
    name: "重建组",
    leader: { sessionId: "s-re", name: "leader", cwd: "/repo" },
  }, 1006, path);
  assert.equal(recreated.name, "重建组");
  assert.ok(readdirSync(join(path, "..")).some((f) => f.startsWith("teams.json.corrupt-")));

  // validateTeamDraft 预检
  assert.throws(() => store.validateTeamDraft({ name: "", leader: { name: "leader" } }, path), /团队名不能为空/);
  assert.throws(() => store.validateTeamDraft({ name: "a".repeat(200), leader: { name: "leader" } }, path), /团队名不能超过/);

  assert.ok(rev.id);
});

test("board card permissions: leader vs assignee vs reviewer vs unrelated member", async () => {
  const path = tempStore();
  const team = await store.createTeam({
    name: "核心组",
    leader: { sessionId: "s-l", name: "leader", cwd: "/p" },
  }, 1000, path);
  const leader = team.members[0];
  const dev1 = await store.addTeamMember(team.id, { sessionId: "s-d1", name: "dev-1", cwd: "/p" }, 1001, path);
  const dev2 = await store.addTeamMember(team.id, { sessionId: "s-d2", name: "dev-2", cwd: "/p" }, 1002, path);
  const rev1 = await store.addTeamMember(team.id, { sessionId: "s-r1", name: "review-1", cwd: "/p" }, 1003, path);

  const card = await store.createTeamCard(team.id, {
    title: "退款接口",
    description: "实现退款回调与幂等",
    assignee: "dev-1",
    reviewer: "review-1",
  }, leader.id, 1004, path);
  assert.equal(card.status, "todo");
  assert.equal(card.assigneeId, dev1.id);
  assert.equal(card.reviewerId, rev1.id);

  // 无关成员 dev-2 不能改这张卡
  await assert.rejects(
    store.updateTeamCard(team.id, card.id, { status: "doing" }, dev2.id, 1005, path),
    /只能更新自己负责或审核的卡片/,
  );

  // 负责人 dev-1 不能改标题或指派
  await assert.rejects(
    store.updateTeamCard(team.id, card.id, { title: "篡改标题" }, dev1.id, 1006, path),
    /只有 leader/,
  );

  // 乐观并发控制：队友已改状态后，携带旧 updatedAt 改字段会被拒绝，但仅追加备注不会覆盖状态
  const concurrentMove = await store.updateTeamCard(team.id, card.id, { status: "doing" }, dev1.id, 1006, path);
  await assert.rejects(
    store.updateTeamCard(team.id, card.id, { status: "todo", expectedUpdatedAt: card.updatedAt }, "user", 1007, path),
    (err) => err instanceof store.TeamCardConflictError && err.card.status === "doing",
  );
  const noteOnly = await store.updateTeamCard(team.id, card.id, { note: "补充说明", expectedUpdatedAt: card.updatedAt }, "user", 1007, path);
  assert.equal(noteOnly.card.status, "doing");
  assert.equal(noteOnly.card.notes.at(-1).text, "补充说明");
  assert.equal(concurrentMove.card.status, "doing");

  // 负责人可以把状态推到 review 并写进度
  const moved = await store.updateTeamCard(team.id, card.id, { status: "review", note: "单测已过" }, dev1.id, 1007, path);
  assert.equal(moved.previousStatus, "doing");
  assert.equal(moved.card.status, "review");
  assert.equal(moved.card.notes.at(-1).text, "单测已过");

  // 审核人可以把卡片标记完成
  const approved = await store.updateTeamCard(team.id, card.id, { status: "done", note: "审核通过" }, rev1.id, 1008, path);
  assert.equal(approved.card.status, "done");

  // 同毫秒连续写入仍严格推进 updatedAt，旧版本会被乐观锁拦截
  const sameMs1 = await store.updateTeamCard(team.id, card.id, { status: "review" }, "user", 1008, path);
  const sameMs2 = await store.updateTeamCard(team.id, card.id, { status: "done" }, "user", 1008, path);
  assert.ok(sameMs1.card.updatedAt > approved.card.updatedAt);
  assert.ok(sameMs2.card.updatedAt > sameMs1.card.updatedAt);
  await assert.rejects(
    store.updateTeamCard(team.id, card.id, { status: "todo", expectedUpdatedAt: sameMs1.card.updatedAt }, "user", 1008, path),
    (err) => err instanceof store.TeamCardConflictError && err.card.updatedAt === sameMs2.card.updatedAt,
  );

  // 移除成员会清空其在卡片上的指派，并推进卡片版本防止旧快照覆盖
  await store.removeTeamMember(team.id, dev1.id, 1008, path);
  const afterRemove = store.getTeam(team.id, path).cards[0];
  assert.equal(afterRemove.assigneeId, undefined);
  assert.ok(afterRemove.updatedAt > sameMs2.card.updatedAt);
  await assert.rejects(
    store.updateTeamCard(team.id, card.id, { status: "todo", expectedUpdatedAt: sameMs2.card.updatedAt }, "user", 1009, path),
    (err) => err instanceof store.TeamCardConflictError && err.card.updatedAt === afterRemove.updatedAt,
  );
});

test("prompt section, turn summary, and hop counter helpers", () => {
  const team = {
    id: "t1",
    name: "支付组",
    prompt: "确保资金安全",
    members: [
      { id: "m1", sessionId: "s1", name: "leader", role: "leader", title: "架构", prompt: "协调分工", cwd: "/p", createdAt: 1 },
      { id: "m2", sessionId: "s2", name: "dev-1", role: "member", title: "开发", prompt: "负责核心接口", cwd: "/p2", createdAt: 2 },
    ],
    cards: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const section = ext.buildTeamPromptSection(team, team.members[1]);
  assert.match(section, /支付组/);
  assert.match(section, /确保资金安全/);
  assert.match(section, /负责核心接口/);
  assert.match(section, /dev-1（你）/);
  assert.match(section, /不要发“收到”/);
  // 当独立补充提示词扩展已加载时跳过职责定义，避免重复注入；未加载时使用会话快照覆盖内容
  const deduped = ext.buildTeamPromptSection(team, team.members[1], { memberPromptOverride: null });
  assert.doesNotMatch(deduped, /你的职责定义/);
  const overridden = ext.buildTeamPromptSection(team, team.members[1], { memberPromptOverride: "改写后的职责" });
  assert.match(overridden, /改写后的职责/);
  assert.doesNotMatch(overridden, /负责核心接口/);

  assert.equal(
    ext.extractTurnSummary([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "\n  已完成接口改造\n第二行" }] },
    ]),
    "已完成接口改造",
  );

  // 人类消息归零，团队消息延续跳数
  assert.equal(ext.readCurrentTurnHop([
    { type: "custom_message", customType: wakeTypes.TEAM_MESSAGE_TYPE, details: { hop: 4 } },
    { type: "message", message: { role: "user" } },
  ]), 0);
  assert.equal(ext.readCurrentTurnHop([
    { type: "message", message: { role: "user" } },
    { type: "custom_message", customType: wakeTypes.TEAM_MESSAGE_TYPE, details: { hop: 3 } },
  ]), 3);
  assert.equal(wakeTypes.WAKE_MESSAGE_TYPES.has(wakeTypes.TEAM_MESSAGE_TYPE), true);
});
