import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDraftFromUserMessage } = await jiti.import("./draft-store.ts");

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
