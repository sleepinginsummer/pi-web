import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./team-role-presets.ts");

function tempPath(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-role-presets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "team-role-presets.json");
}

test("team role presets CRUD, uniqueness, lookup by name/id, and corrupt recovery", async (t) => {
  const path = tempPath(t);
  assert.deepEqual(store.listTeamRolePresets(path), []);

  const backend = await store.createTeamRolePreset(
    { name: "后端开发", prompt: "负责接口设计与数据一致性" },
    1000,
    path,
  );
  const reviewer = await store.createTeamRolePreset(
    { name: "Code Reviewer", prompt: "专注边界条件、安全与回归风险" },
    1001,
    path,
  );

  assert.equal(store.listTeamRolePresets(path).length, 2);
  assert.equal(store.getTeamRolePreset("code reviewer", path)?.id, reviewer.id);
  assert.equal(store.getTeamRolePreset(backend.id, path)?.name, "后端开发");

  // 名称不区分大小写判重
  await assert.rejects(
    store.createTeamRolePreset({ name: "CODE REVIEWER", prompt: "dup" }, 1002, path),
    /已存在/,
  );

  // 按名称更新
  const updated = await store.updateTeamRolePreset("后端开发", { prompt: "负责核心支付接口" }, 1003, path);
  assert.equal(updated.prompt, "负责核心支付接口");
  assert.equal(store.getTeamRolePreset(backend.id, path)?.prompt, "负责核心支付接口");

  // 按 id 删除
  const removed = await store.deleteTeamRolePreset(reviewer.id, 1004, path);
  assert.equal(removed?.id, reviewer.id);
  assert.equal(store.listTeamRolePresets(path).length, 1);

  // 只读路径损坏不写盘；持锁写入时备份并恢复
  writeFileSync(path, "{broken");
  assert.deepEqual(store.listTeamRolePresets(path), []);
  assert.equal(readdirSync(join(path, "..")).some((f) => f.startsWith("team-role-presets.json.corrupt-")), false);
  const recreated = await store.createTeamRolePreset({ name: "测试工程师", prompt: "写回归用例" }, 1005, path);
  assert.equal(recreated.name, "测试工程师");
  assert.ok(readdirSync(join(path, "..")).some((f) => f.startsWith("team-role-presets.json.corrupt-")));


  // 乐观锁：同毫秒连续更新推进 updatedAt，旧版本更新抛出 TeamRolePresetConflictError
  const v1 = await store.updateTeamRolePreset(recreated.id, { prompt: "v1" }, 1005, path);
  const v2 = await store.updateTeamRolePreset(recreated.id, { prompt: "v2" }, 1005, path);
  assert.ok(v1.updatedAt > recreated.updatedAt);
  assert.ok(v2.updatedAt > v1.updatedAt);
  await assert.rejects(
    store.updateTeamRolePreset(recreated.id, { name: "旧版改名", expectedUpdatedAt: v1.updatedAt }, 1006, path),
    (err) => err instanceof store.TeamRolePresetConflictError && err.preset.updatedAt === v2.updatedAt,
  );
  await assert.rejects(
    store.deleteTeamRolePreset(recreated.id, 1006, path, { matchBy: "id", expectedUpdatedAt: v1.updatedAt }),
    (err) => err instanceof store.TeamRolePresetConflictError && err.preset.updatedAt === v2.updatedAt,
  );
  assert.equal(store.getTeamRolePreset(recreated.id, path, "id")?.prompt, "v2");

  // ID 优先查找与严格 matchBy: "id"：即使更早一条预设的 name 恰好等于另一条的 id，也不会误命中
  const second = await store.createTeamRolePreset({ name: "第二条", prompt: "p2" }, 1007, path);
  await store.updateTeamRolePreset(recreated.id, { name: second.id }, 1008, path);
  assert.equal(store.getTeamRolePreset(second.id, path)?.id, second.id);
  const updatedById = await store.updateTeamRolePreset(second.id, { prompt: "仅改第二条" }, 1009, path, { matchBy: "id" });
  assert.equal(updatedById.id, second.id);
  assert.equal(store.getTeamRolePreset(recreated.id, path, "id")?.prompt, "v2");
  // matchBy: "id" 不按名称匹配
  await assert.rejects(
    store.updateTeamRolePreset("第二条", { prompt: "should fail" }, 1010, path, { matchBy: "id" }),
    /不存在/,
  );
});
