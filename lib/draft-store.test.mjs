import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearDraft,
  captureDraftTransfer,
  getDraft,
  clearDraftRestorePending,
  createDraftFromUserMessage,
  hasPendingDraftRestore,
  markDraftRestorePending,
  notifyRecalledDraft,
  recallRevision,
  setDraft,
  subscribeDraftRestore,
  subscribeRecalledDraft,
} = await jiti.import("./draft-store.ts");

test("迁移原草稿一次并清除未变的源，保留正文、图片和文本附件", () => {
  const source = "new:/migration-a";
  const target = "migration-session";
  const draft = { value: "原草稿", images: [{ data: "image-data", mimeType: "image/png" }], textAttachment: "大段文本" };
  setDraft(source, draft);
  clearDraft(target);
  const transfer = captureDraftTransfer(source);
  transfer(target);
  assert.equal(getDraft(source), null);
  assert.deepEqual(getDraft(target), draft);
  transfer(target);
  assert.deepEqual(getDraft(target), draft, "重复确认不能重复追加同一份草稿");
  clearDraft(target);
});

test("迁移只清除捕获的源记录，等待期间新写的正文和附件留在原键", () => {
  const source = "new:/migration-late";
  const target = "migration-late-session";
  const original = { value: "旧正文", textAttachment: undefined, images: [{ data: "old", mimeType: "image/png" }] };
  const updated = { value: "新正文", textAttachment: undefined, images: [{ data: "new", mimeType: "image/png" }] };
  setDraft(source, original);
  clearDraft(target);
  const transfer = captureDraftTransfer(source);
  setDraft(source, updated);
  transfer(target);
  assert.deepEqual(getDraft(source), updated);
  assert.deepEqual(getDraft(target), original);
  clearDraft(source);
  clearDraft(target);
});

test("相同内容在重挂载后写回，仍清除已迁移的源记录", () => {
  const source = "new:/migration-remount";
  const target = "migration-remount-session";
  const draft = { value: "未编辑", images: [{ data: "same", mimeType: "image/png" }], textAttachment: "相同文本" };
  setDraft(source, draft);
  clearDraft(target);
  const transfer = captureDraftTransfer(source);
  // getDraft 返回副本：模拟输入框重挂载时重新构建图片数组并写回。
  setDraft(source, getDraft(source));
  transfer(target);
  assert.equal(getDraft(source), null);
  assert.deepEqual(getDraft(target), draft);
  clearDraft(target);
});

test("将用户字符串消息转换为文本草稿", () => {
  assert.deepEqual(
    createDraftFromUserMessage({ role: "user", content: "继续修改" }),
    { value: "继续修改", images: [] },
  );
});

test("将用户内容块转换为文本和有效 base64 图片草稿", () => {
  const draft = createDraftFromUserMessage({
    role: "user",
    content: [
      { type: "text", text: "第一段" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      { type: "text", text: "第二段" },
    ],
  });

  assert.deepEqual(draft, {
    value: "第一段\n第二段",
    images: [{ data: "abc", mimeType: "image/png" }],
  });
});

test("a recalled draft stays flagged until the transcript loads or the draft is gone", () => {
  const key = "session:pending-restore";
  markDraftRestorePending(key);
  assert.equal(hasPendingDraftRestore(key), true, "the page can still warn before a reload");
  setDraft(key, { value: "已取回的消息", images: [] });
  assert.equal(hasPendingDraftRestore(key), true, "still the only copy");

  clearDraftRestorePending(key);
  assert.equal(hasPendingDraftRestore(key), false, "the transcript loaded");

  // 发出去、被清空或用户手动清掉草稿时，这份内容不再需要保护。
  markDraftRestorePending(key);
  setDraft(key, { value: "", images: [] });
  assert.equal(hasPendingDraftRestore(key), false);
  markDraftRestorePending(key);
  setDraft(key, { value: "再写一条", images: [] });
  clearDraft(key);
  assert.equal(hasPendingDraftRestore(key), false);
});

test("a recall delivered late reaches the composer mounted for that session", () => {
  const key = "session:late-recall";
  const seen = [];
  const unsubscribe = subscribeRecalledDraft(key, (draft) => seen.push(draft));

  // 另一个会话的交付不受影响。
  notifyRecalledDraft("session:other", { value: "别人的", images: [] });
  assert.deepEqual(seen, []);

  notifyRecalledDraft(key, { value: "迟到的取回", images: [] });
  assert.deepEqual(seen.map((draft) => draft.value), ["迟到的取回"]);

  unsubscribe();
  notifyRecalledDraft(key, { value: "卸载后不该收到", images: [] });
  assert.equal(seen.length, 1);
});

test("a late recall flips the mounted session into the restored state", () => {
  const key = "session:late-restore";
  let notified = 0;
  const unsubscribe = subscribeDraftRestore(key, () => { notified += 1; });

  // 另一会话的取回不该惊动这里。
  markDraftRestorePending("session:other");
  assert.equal(notified, 0);

  markDraftRestorePending(key);
  assert.equal(notified, 1, "the mounted page switches to the restored state");
  assert.equal(hasPendingDraftRestore(key), true);

  unsubscribe();
  markDraftRestorePending(key);
  assert.equal(notified, 1, "nothing listens after unmount");
});

test("the recall revision notices a delivery that a cleared restore marker would hide", () => {
  const key = "session:revision";
  const before = recallRevision(key);
  notifyRecalledDraft(key, { value: "取回", images: [] });
  assert.ok(recallRevision(key) > before, "a delivery advances the revision");

  // 上下文加载成功后恢复标记会被清掉；版本号不受影响，补收仍然看得到这次投递。
  clearDraftRestorePending(key);
  assert.equal(recallRevision(key) > before, true);
});
