import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearDraft,
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
