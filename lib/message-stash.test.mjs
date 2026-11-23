import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  changeStashedMessage, claimStashedMessage, dueStashedMessages, finishStashedMessage,
  listStashedMessages, loadStashedContent, parseStashedContent, saveStashedMessage,
} = await jiti.import("./message-stash.ts");

async function testStore(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-message-stash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "messages.json");
}

const project = "/stash/project";
const draft = { text: "测试草稿", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }] };

test("项目暂存库持久保存文字和图片，修改时防止覆盖另一设备的新版本", async (t) => {
  const path = await testStore(t);
  const first = await saveStashedMessage(project, draft, undefined, path);
  const second = await saveStashedMessage(project, { text: "第二条", images: [] }, undefined, path);
  assert.deepEqual(listStashedMessages(project, path).map(({ id, imageCount }) => [id, imageCount]), [[second.id, 0], [first.id, 1]]);
  assert.deepEqual(listStashedMessages("/stash/other", path), []);
  await assert.rejects(loadStashedContent("/stash/other", first.id, first.revision, path), { status: 404 });
  assert.deepEqual(await loadStashedContent(project, first.id, first.revision, path), draft);
  const replaced = await saveStashedMessage(project, { text: "已编辑", images: [] }, first, path);
  await assert.rejects(changeStashedMessage(project, first.id, first.revision, "delete", path), { status: 409 });
  assert.deepEqual(await loadStashedContent(project, replaced.id, replaced.revision, path), { text: "已编辑", images: [] });
  await changeStashedMessage(project, replaced.id, replaced.revision, "delete", path);
  assert.equal(listStashedMessages(project, path).length, 1);
});

test("定时消息可改期和取消，只能认领一次，明确失败后保留原文和图片", async (t) => {
  const path = await testStore(t);
  const initial = await saveStashedMessage(project, draft, undefined, path);
  const updateSchedule = async (at) => {
    const [item] = listStashedMessages(project, path);
    await changeStashedMessage(project, item.id, item.revision, { at, sessionId: "target", label: "目标会话" }, path);
    return listStashedMessages(project, path)[0];
  };
  const future = await updateSchedule(Date.now() + 60_000);
  assert.deepEqual(dueStashedMessages(Date.now(), path), []);
  await assert.rejects(claimStashedMessage(project, future.id, future.revision, false, path), { status: 409 });
  await changeStashedMessage(project, future.id, future.revision, null, path);
  assert.equal(dueStashedMessages(Date.now() + 120_000, path).length, 0);
  const due = await updateSchedule(Date.now() - 1);
  assert.equal(dueStashedMessages(Date.now(), path)[0].id, initial.id);
  const results = await Promise.allSettled([
    claimStashedMessage(project, due.id, due.revision, true, path),
    claimStashedMessage(project, due.id, due.revision, true, path),
  ]);
  const [claimed] = results.filter(({ status }) => status === "fulfilled");
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.deepEqual(claimed.value.draft, draft);
  assert.deepEqual(dueStashedMessages(Date.now(), path), []);
  const [sending] = listStashedMessages(project, path);
  await assert.rejects(changeStashedMessage(project, sending.id, sending.revision, null, path), { status: 409 });
  await assert.rejects(finishStashedMessage(project, due.id, "wrong-token", true, path), { status: 409 });
  await finishStashedMessage(project, due.id, claimed.value.token, false, path);
  const [failed] = listStashedMessages(project, path);
  assert.equal(failed.status, "failed");
  assert.equal(failed.schedule, undefined);
  const retry = await claimStashedMessage(project, failed.id, failed.revision, false, path);
  assert.deepEqual(retry.draft, draft);
  await finishStashedMessage(project, failed.id, retry.token, true, path);
  assert.deepEqual(listStashedMessages(project, path), []);
});

test("失败的暂存编辑保存后重新排队，不再显示失败", async (t) => {
  const path = await testStore(t);
  const created = await saveStashedMessage(project, draft, undefined, path);
  const claimed = await claimStashedMessage(project, created.id, created.revision, false, path);
  // 明确投递失败：条目留在库里并标记 failed。
  await finishStashedMessage(project, created.id, claimed.token, false, path);
  const [failed] = listStashedMessages(project, path);
  assert.equal(failed.status, "failed");

  // 改完内容点保存：这是重新排队，不该继续显示「失败」。
  const saved = await saveStashedMessage(project, { text: "重写过的", images: [] }, failed, path);
  assert.equal(saved.status, "ready");
  assert.deepEqual(listStashedMessages(project, path).map(({ status, preview }) => [status, preview]), [["ready", "重写过的"]]);
});

test("投递确认丢失后保持锁定，超时后才允许手动恢复", async (t) => {
  const path = await testStore(t);
  const clock = t.mock.method(Date, "now", () => 1_000);
  const entry = await saveStashedMessage(project, draft, undefined, path);
  const claim = await claimStashedMessage(project, entry.id, entry.revision, false, path);
  const [sending] = listStashedMessages(project, path);
  assert.equal(sending.status, "sending");
  await assert.rejects(changeStashedMessage(project, sending.id, sending.revision, "recover", path), { status: 409 });
  clock.mock.mockImplementation(() => 1_000 + 15 * 60_000);
  const [uncertain] = listStashedMessages(project, path);
  assert.equal(uncertain.status, "uncertain");
  assert.deepEqual(dueStashedMessages(Date.now(), path), []);
  await changeStashedMessage(project, uncertain.id, uncertain.revision, "recover", path);
  await assert.rejects(finishStashedMessage(project, uncertain.id, claim.token, true, path), { status: 409 });
  const [restored] = listStashedMessages(project, path);
  assert.equal(restored.status, "ready");
  assert.deepEqual(await loadStashedContent(project, restored.id, restored.revision, path), draft);
});

test("仅图片也可以暂存，空白消息和非法图片被拒绝", () => {
  assert.deepEqual(parseStashedContent("", draft.images), { text: "", images: draft.images });
  assert.throws(() => parseStashedContent("  ", []), { status: 400 });
  assert.throws(() => parseStashedContent("test", [{ mimeType: "image/png", data: "!!!" }]), { status: 400 });
});

test("消息类型持久化，改类型保留定时并让到期投递使用新类型", async (t) => {
  const path = await testStore(t);
  let item = await saveStashedMessage(project, draft, undefined, path);
  assert.equal(item.mode, "steer");
  await changeStashedMessage(project, item.id, item.revision, { at: Date.now() - 1, sessionId: "target", label: "目标会话" }, path);
  [item] = listStashedMessages(project, path);
  const schedule = item.schedule;
  await changeStashedMessage(project, item.id, item.revision, "followUp", path);
  await assert.rejects(changeStashedMessage(project, item.id, item.revision, "steer", path), { status: 409 });
  [item] = listStashedMessages(project, path);
  assert.equal(item.mode, "followUp");
  assert.deepEqual(item.schedule, schedule);
  assert.equal(dueStashedMessages(Date.now(), path)[0].mode, "followUp");
  await changeStashedMessage(project, item.id, item.revision, "steer", path);
  [item] = listStashedMessages(project, path);
  assert.equal(dueStashedMessages(Date.now(), path)[0].mode, "steer");
  const edited = await saveStashedMessage(project, { text: "改正文", images: [] }, item, path);
  assert.equal(edited.mode, "steer");
  const claim = await claimStashedMessage(project, edited.id, edited.revision, true, path);
  const [sending] = listStashedMessages(project, path);
  await assert.rejects(changeStashedMessage(project, sending.id, sending.revision, "followUp", path), { status: 409 });
  await finishStashedMessage(project, sending.id, claim.token, false, path);
  [item] = listStashedMessages(project, path);
  assert.equal(item.mode, "steer");
  assert.equal(item.schedule, undefined);
});

test("旧索引没有消息类型时保持后续语义", async (t) => {
  const path = await testStore(t);
  const { readFile, writeFile } = await import("node:fs/promises");
  const item = await saveStashedMessage(project, draft, undefined, path);
  await changeStashedMessage(project, item.id, item.revision, { at: Date.now() - 1, sessionId: "target", label: "目标会话" }, path);
  const store = JSON.parse(await readFile(path, "utf8"));
  delete store.items[0].mode;
  await writeFile(path, JSON.stringify(store));
  const [legacy] = listStashedMessages(project, path);
  assert.equal(legacy.mode, "followUp");
  assert.equal(dueStashedMessages(Date.now(), path)[0].mode, "followUp");
  assert.equal((await saveStashedMessage(project, draft, legacy, path)).mode, "followUp");
});
