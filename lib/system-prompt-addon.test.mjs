import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  cleanupTeamRoleSystemPromptAddon,
  ensureTeamMemberRolePromptAddon,
  ensureTeamMemberRolePromptAddonLocked,
  readSessionSystemPromptAddon,
  projectEffectiveSystemPromptAddon,
  syncTeamRoleIntoSessionAddon,
  updateSessionSystemPromptAddonLocked,
  withSessionSystemPromptAddonLock,
  SYSTEM_PROMPT_ADDON_MAX_LENGTH,
  appendSystemPromptAddon,
  ensureSessionSystemPromptAddon,
  isSystemPromptAddonExtension,
  readDefaultSystemPromptAddonText,
  updateSessionSystemPromptAddon,
  viewSessionSystemPromptAddon,
  withSessionSystemPromptAddon,
  writeDefaultSystemPromptAddonText,
} = await jiti.import("./system-prompt-addon.ts");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-addon-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a session is off by default and previews the default text without a snapshot", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: false, text: "" });
  writeDefaultSystemPromptAddonText("one", dir);
  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: false, text: "one" });
  writeDefaultSystemPromptAddonText("two", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "two");
});

test("a started session keeps its copy when the default changes", (t) => {
  const dir = tempDir(t);
  writeDefaultSystemPromptAddonText("original", dir);
  ensureSessionSystemPromptAddon("a", dir);
  writeDefaultSystemPromptAddonText("changed", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "original");
  ensureSessionSystemPromptAddon("b", dir);
  assert.equal(viewSessionSystemPromptAddon("b", dir).text, "changed");
});

test("started sessions stay isolated and do not overwrite the default", (t) => {
  const dir = tempDir(t);
  writeDefaultSystemPromptAddonText("default", dir);
  updateSessionSystemPromptAddon("a", { enabled: true, text: "for a" }, dir);
  updateSessionSystemPromptAddon("b", { text: "for b" }, dir);

  assert.deepEqual(viewSessionSystemPromptAddon("a", dir), { enabled: true, text: "for a" });
  assert.deepEqual(viewSessionSystemPromptAddon("b", dir), { enabled: false, text: "for b" });
  assert.equal(readDefaultSystemPromptAddonText(dir), "default");
  assert.equal(viewSessionSystemPromptAddon("new", dir).text, "default");
});

test("a partial session update keeps the other field", (t) => {
  const dir = tempDir(t);
  updateSessionSystemPromptAddon("a", { text: "kept" }, dir);
  assert.deepEqual(updateSessionSystemPromptAddon("a", { enabled: true }, dir), { enabled: true, text: "kept" });
});

test("rejects oversized text and session ids that would escape the directory", (t) => {
  const dir = tempDir(t);
  const oversized = "x".repeat(SYSTEM_PROMPT_ADDON_MAX_LENGTH + 1);
  assert.throws(() => writeDefaultSystemPromptAddonText(oversized, dir), RangeError);
  assert.throws(() => updateSessionSystemPromptAddon("a", { text: oversized }, dir), RangeError);
  assert.throws(() => updateSessionSystemPromptAddon("../evil", { enabled: true }, dir), RangeError);
});

test("a damaged default reads as empty", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pi-web-system-prompt-addon.json"), "{broken");
  assert.equal(readDefaultSystemPromptAddonText(dir), "");
});

test("appends only when enabled and non-blank", () => {
  assert.equal(appendSystemPromptAddon("Base\n", { enabled: true, text: " Extra\n" }), "Base\n\nExtra");
  assert.equal(appendSystemPromptAddon(" ", { enabled: true, text: "Extra" }), "Extra");
  assert.equal(appendSystemPromptAddon("Base", { enabled: false, text: "Extra" }), undefined);
  assert.equal(appendSystemPromptAddon("Base", { enabled: true, text: "  \n" }), undefined);
});

test("recognizes the extension by its install path", () => {
  assert.equal(isSystemPromptAddonExtension({ path: "/x/git/github.com/sleepinginsummer/pi-system-prompt-addon/index.ts" }), true);
  assert.equal(isSystemPromptAddonExtension({ path: "/x/pi-shadow-mind/index.ts" }), false);
  assert.equal(isSystemPromptAddonExtension({}), false);
});

test("a staged new-session switch is written to the real session before the id is returned, and only once", async (t) => {
  const client = await jiti.import("./system-prompt-addon-client.ts");
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ enabled: true, text: "" }), { status: 200 });
  };

  await client.commitStagedSystemPromptAddon("/not-staged", "s0");
  assert.deepEqual(calls, []);

  client.setSystemPromptAddonStaged("/cwd", true);
  await client.commitStagedSystemPromptAddon("/cwd", "s1");
  await client.commitStagedSystemPromptAddon("/cwd", "s1");
  assert.deepEqual(calls, [{ sessionId: "s1", enabled: true }]);
  assert.equal(client.isSystemPromptAddonStaged("/cwd"), false);
});

test("the panel text matches the request and viewing creates no snapshot", (t) => {
  const dir = tempDir(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  writeDefaultSystemPromptAddonText("first", dir);
  assert.equal(withSessionSystemPromptAddon("Base", "a"), "Base");
  writeDefaultSystemPromptAddonText("second", dir);
  assert.equal(viewSessionSystemPromptAddon("a", dir).text, "second");

  updateSessionSystemPromptAddon("a", { enabled: true }, dir);
  assert.equal(withSessionSystemPromptAddon("Base", "a"), "Base\n\nsecond");
  assert.equal(withSessionSystemPromptAddon("Base", "../bad"), "Base");
});


test("migrates legacy team member roles, replaces/cleans only role segments, and isolates disabled or oversized drafts", (t) => {
  const dir = tempDir(t);
  writeDefaultSystemPromptAddonText("global default", dir);

  // 1. 旧成员无快照：直接迁移并标记 teamManaged
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-1", "负责支付接口", dir),
    { mode: "snapshot", addon: { enabled: true, text: "负责支付接口" } },
  );
  // 用户关闭开关后不会再被重新打开；移出团队可清理
  updateSessionSystemPromptAddon("legacy-1", { enabled: false }, dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-1", "负责支付接口", dir),
    { mode: "snapshot", addon: { enabled: false, text: "负责支付接口" } },
  );
  cleanupTeamRoleSystemPromptAddon("legacy-1", dir);
  assert.equal(readSessionSystemPromptAddon("legacy-1", dir), null);

  // 2. 旧成员仅有未启用的全局默认副本：替换为团队职责
  ensureSessionSystemPromptAddon("legacy-2", dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-2", "负责审核", dir),
    { mode: "snapshot", addon: { enabled: true, text: "负责审核" } },
  );
  // 用户完全改写正文后不再被移出团队清理，也不会被再次迁移覆盖
  updateSessionSystemPromptAddon("legacy-2", { text: "我的自定义提示" }, dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-2", "负责审核", dir),
    { mode: "snapshot", addon: { enabled: true, text: "我的自定义提示" } },
  );
  cleanupTeamRoleSystemPromptAddon("legacy-2", dir);
  assert.deepEqual(readSessionSystemPromptAddon("legacy-2", dir), { enabled: true, text: "我的自定义提示" });

  // 3. 旧成员已有启用的用户自定义内容：合并保留，更新职责只替换职责片段，移出团队只剥离职责片段
  updateSessionSystemPromptAddon("legacy-3", { enabled: true, text: "请用中文回答" }, dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-3", "负责前端", dir),
    { mode: "snapshot", addon: { enabled: true, text: "负责前端\n\n请用中文回答" } },
  );
  syncTeamRoleIntoSessionAddon("legacy-3", "负责全栈", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-3", dir),
    { enabled: true, text: "负责全栈\n\n请用中文回答" },
  );
  cleanupTeamRoleSystemPromptAddon("legacy-3", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-3", dir),
    { enabled: true, text: "请用中文回答" },
  );

  // 4. 旧成员已有停用的自定义草稿：不擅自启用也不覆盖，职责单独生效
  updateSessionSystemPromptAddon("legacy-4", { enabled: false, text: "停用的草稿" }, dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-4", "负责测试", dir),
    { mode: "separate", addon: { enabled: false, text: "停用的草稿" }, separateRoleText: "负责测试" },
  );
  assert.deepEqual(readSessionSystemPromptAddon("legacy-4", dir), { enabled: false, text: "停用的草稿" });

  // 5. 100,000 字符自定义快照叠加旧职责超限：不抛错，保留原快照并走 separate 模式
  const maxText = "a".repeat(SYSTEM_PROMPT_ADDON_MAX_LENGTH);
  updateSessionSystemPromptAddon("legacy-5", { enabled: true, text: maxText }, dir);
  const overflow = ensureTeamMemberRolePromptAddon("legacy-5", "负责架构", dir);
  assert.equal(overflow.mode, "separate");
  assert.equal(overflow.separateRoleText, "负责架构");
  assert.equal(readSessionSystemPromptAddon("legacy-5", dir)?.text.length, SYSTEM_PROMPT_ADDON_MAX_LENGTH);

  // 6. 面板只读投影：未安装独立扩展时也能显示团队职责，且不写盘
  assert.equal(
    projectEffectiveSystemPromptAddon("Base", "unmigrated-team", {
      addonExtensionLoaded: false,
      isTeamMember: true,
      teamMemberPrompt: "负责运维",
      agentDir: dir,
    }),
    "Base\n\n负责运维",
  );
  assert.equal(readSessionSystemPromptAddon("unmigrated-team", dir), null);
  assert.equal(
    projectEffectiveSystemPromptAddon("Base", "legacy-4", {
      addonExtensionLoaded: true,
      isTeamMember: true,
      teamMemberPrompt: "负责测试",
      agentDir: dir,
    }),
    "Base\n\n负责测试",
  );
  // 7. 用户把“负责测试”改写成“不再负责测试”后不再按子串误删
  ensureTeamMemberRolePromptAddon("legacy-6", "负责测试", dir);
  updateSessionSystemPromptAddon("legacy-6", { text: "不再负责测试" }, dir);
  cleanupTeamRoleSystemPromptAddon("legacy-6", dir);
  assert.deepEqual(readSessionSystemPromptAddon("legacy-6", dir), { enabled: true, text: "不再负责测试" });

  // 8. 恰好等于全局默认文本但没有 fromDefault 标记的停用草稿，迁移不得覆盖或启用
  updateSessionSystemPromptAddon("legacy-7", { enabled: false, text: "global default" }, dir);
  assert.deepEqual(
    ensureTeamMemberRolePromptAddon("legacy-7", "负责安全", dir),
    { mode: "separate", addon: { enabled: false, text: "global default" }, separateRoleText: "负责安全" },
  );
  assert.deepEqual(readSessionSystemPromptAddon("legacy-7", dir), { enabled: false, text: "global default" });

  // 9. 无独立扩展且超限 separate 模式下，面板投影同时包含已启用的自定义快照和独立职责
  assert.equal(
    projectEffectiveSystemPromptAddon("Base", "legacy-5", {
      addonExtensionLoaded: false,
      isTeamMember: true,
      teamMemberPrompt: "负责架构",
      agentDir: dir,
    }),
    `Base\n\n${maxText}\n\n负责架构`,
  );

  // 10. syncTeamRoleIntoSessionAddon 回滚仅撤销本次写入，不覆盖并发顶栏编辑
  ensureTeamMemberRolePromptAddon("legacy-8", "旧职责", dir);
  const rollback1 = syncTeamRoleIntoSessionAddon("legacy-8", "新职责", dir);
  assert.equal(readSessionSystemPromptAddon("legacy-8", dir)?.text, "新职责");
  rollback1();
  assert.equal(readSessionSystemPromptAddon("legacy-8", dir)?.text, "旧职责");

  const rollback2 = syncTeamRoleIntoSessionAddon("legacy-8", "并发职责", dir);
  updateSessionSystemPromptAddon("legacy-8", { enabled: false, text: "用户并发修改" }, dir);
  rollback2();
  assert.deepEqual(readSessionSystemPromptAddon("legacy-8", dir), { enabled: false, text: "用户并发修改" });


  // 11. 同文示例段落：改写原职责后保留另一独立段落中的同名示例，不再误删或误改
  updateSessionSystemPromptAddon("legacy-9", { enabled: true, text: "示例：\n\n负责测试" }, dir);
  ensureTeamMemberRolePromptAddon("legacy-9", "负责测试", dir);
  // 此时原文里已有独立段落“负责测试”，不会重复拼装也不会误归属；再用明确由团队写入的同文场景验证
  ensureTeamMemberRolePromptAddon("legacy-10", "负责测试", dir);
  updateSessionSystemPromptAddon("legacy-10", { text: "负责测试\n\n示例：\n\n负责测试" }, dir);
  // 用户把第 1 段的“负责测试”改写成“不再负责测试”，第 3 段示例仍是“负责测试”
  updateSessionSystemPromptAddon("legacy-10", { text: "不再负责测试\n\n示例：\n\n负责测试" }, dir);
  syncTeamRoleIntoSessionAddon("legacy-10", "新职责", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-10", dir),
    { enabled: true, text: "不再负责测试\n\n示例：\n\n负责测试" },
  );
  cleanupTeamRoleSystemPromptAddon("legacy-10", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-10", dir),
    { enabled: true, text: "不再负责测试\n\n示例：\n\n负责测试" },
  );

  // 12. 单次编辑把“负责测试”改写成“不再负责测试”并在文末新增同文示例“负责测试”：无法区分前插与替换，解除团队归属
  ensureTeamMemberRolePromptAddon("legacy-11", "负责测试", dir);
  updateSessionSystemPromptAddon("legacy-11", { text: "不再负责测试\n\n负责测试" }, dir);
  syncTeamRoleIntoSessionAddon("legacy-11", "新职责", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-11", dir),
    { enabled: true, text: "不再负责测试\n\n负责测试" },
  );
  cleanupTeamRoleSystemPromptAddon("legacy-11", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-11", dir),
    { enabled: true, text: "不再负责测试\n\n负责测试" },
  );

  // 13. 仅在原职责之后追加内容时原位置与前缀未变，继续保留归属并支持精准替换和清理回滚
  ensureTeamMemberRolePromptAddon("legacy-12", "负责后端", dir);
  updateSessionSystemPromptAddon("legacy-12", { text: "负责后端\n\n补充约束" }, dir);
  syncTeamRoleIntoSessionAddon("legacy-12", "负责核心后端", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-12", dir),
    { enabled: true, text: "负责核心后端\n\n补充约束" },
  );
  const undoCleanup = cleanupTeamRoleSystemPromptAddon("legacy-12", dir);
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-12", dir),
    { enabled: true, text: "补充约束" },
  );
  undoCleanup();
  assert.deepEqual(
    readSessionSystemPromptAddon("legacy-12", dir),
    { enabled: true, text: "负责核心后端\n\n补充约束" },
  );
});

test("session addon lock serializes topbar toggle with team role commit/rollback", async (t) => {
  const dir = tempDir(t);
  ensureTeamMemberRolePromptAddon("locked-1", "旧职责", dir);
  updateSessionSystemPromptAddon("locked-1", { enabled: false }, dir);

  let releaseWrite;
  const writeStarted = new Promise((resolve) => { releaseWrite = resolve; });
  let continueFail;
  const failGate = new Promise((resolve) => { continueFail = resolve; });

  const teamUpdate = withSessionSystemPromptAddonLock("locked-1", async () => {
    const rollback = syncTeamRoleIntoSessionAddon("locked-1", "失败的新职责", dir);
    releaseWrite();
    await failGate;
    // 模拟 teams.json 写盘失败并回滚
    rollback();
  }, dir);

  await writeStarted;
  const topbarToggle = updateSessionSystemPromptAddonLocked("locked-1", { enabled: true }, dir);
  continueFail();
  await Promise.all([teamUpdate, topbarToggle]);

  // 失败的新职责已回滚，用户顶栏启用的是原职责
  assert.deepEqual(
    readSessionSystemPromptAddon("locked-1", dir),
    { enabled: true, text: "旧职责" },
  );


  // 等待锁期间成员已被移出并清理快照：获锁后重读成员资格为空，不得把旧职责重新写回
  let memberStillInTeam = true;
  ensureTeamMemberRolePromptAddon("locked-2", "待移除职责", dir);
  let releaseCleanupLock;
  const cleanupStarted = new Promise((resolve) => { releaseCleanupLock = resolve; });
  let continueCleanup;
  const cleanupGate = new Promise((resolve) => { continueCleanup = resolve; });

  const removeTask = withSessionSystemPromptAddonLock("locked-2", async () => {
    releaseCleanupLock();
    await cleanupGate;
    cleanupTeamRoleSystemPromptAddon("locked-2", dir);
    memberStillInTeam = false;
  }, dir);

  await cleanupStarted;
  const lateMigration = ensureTeamMemberRolePromptAddonLocked(
    "locked-2",
    () => (memberStillInTeam ? "待移除职责" : null),
    dir,
  );
  continueCleanup();
  const [, migrationResult] = await Promise.all([removeTask, lateMigration]);
  assert.deepEqual(migrationResult, { mode: "snapshot", addon: null });
  assert.equal(readSessionSystemPromptAddon("locked-2", dir), null);


  // 事务内清理遇到非 ENOENT 读取异常（如损坏/不可读文件）必须抛出，避免静默提交删人
  writeFileSync(join(dir, "pi-web-system-prompt-addon-sessions", "broken-clean.json"), "{broken");
  assert.throws(() => cleanupTeamRoleSystemPromptAddon("broken-clean", dir));
  writeFileSync(join(dir, "pi-web-system-prompt-addon-sessions", "invalid-schema.json"), JSON.stringify({ enabled: true }));
  assert.throws(() => cleanupTeamRoleSystemPromptAddon("invalid-schema", dir));
  // 迁移遇到损坏/不可读快照时保守不覆写也不重新启用职责
  assert.deepEqual(ensureTeamMemberRolePromptAddon("broken-clean", "负责测试", dir), { mode: "snapshot", addon: null });
  assert.deepEqual(ensureTeamMemberRolePromptAddon("invalid-schema", "负责测试", dir), { mode: "snapshot", addon: null });
  assert.equal(
    projectEffectiveSystemPromptAddon("Base", "broken-clean", {
      addonExtensionLoaded: false,
      isTeamMember: true,
      teamMemberPrompt: "负责测试",
      agentDir: dir,
    }),
    "Base",
  );
  assert.equal(
    projectEffectiveSystemPromptAddon("Base", "invalid-schema", {
      addonExtensionLoaded: false,
      isTeamMember: true,
      teamMemberPrompt: "负责测试",
      agentDir: dir,
    }),
    "Base",
  );
});
