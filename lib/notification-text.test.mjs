import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getAssistantNotificationPreview,
  stripNotificationMarkdown,
} = await jiti.import("./notification-text.ts");
const {
  forgetSessionCompletionSummary,
  listSessionCompletionSummaries,
  recordSessionCompletionSummary,
} = await jiti.import("./session-completion-summaries.ts");

const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("strips markdown markers but keeps the words", () => {
  assert.equal(stripNotificationMarkdown("下载 **`magpie-darwin-arm64.dmg`**（34.5 MB）"), "下载 magpie-darwin-arm64.dmg（34.5 MB）");
  assert.equal(stripNotificationMarkdown("## 结果\n- 见 [文档](https://a.b/c)"), "结果\n见 文档");
  assert.equal(stripNotificationMarkdown("an *emphasis* and 2 * 3 * 4"), "an emphasis and 2 * 3 * 4");
  assert.equal(stripNotificationMarkdown("keep snake_case_name"), "keep snake_case_name");
});

test("previews the last assistant reply that has text, truncated after stripping", () => {
  assert.equal(getAssistantNotificationPreview([assistant("早的"), { role: "user", content: "问" }, assistant("**新的**")]), "新的");
  assert.equal(getAssistantNotificationPreview([assistant("有字"), assistant("  ")]), "有字");
  assert.equal(getAssistantNotificationPreview([assistant(`**${"字".repeat(100)}**`)]), `${"字".repeat(80)}…`);
  assert.equal(getAssistantNotificationPreview([{ role: "user", content: "问" }]), "");
});

test("completion summaries overwrite per session, forget on demand, and stay bounded", () => {
  for (let index = 0; index < 40; index++) {
    recordSessionCompletionSummary({ sessionId: `s${index}`, title: "t", preview: "p" });
  }
  let summaries = listSessionCompletionSummaries();
  assert.equal(summaries.length, 32);
  assert.equal(summaries.some((summary) => summary.sessionId === "s0"), false);

  recordSessionCompletionSummary({ sessionId: "s39", title: "t2", preview: "p2" });
  summaries = listSessionCompletionSummaries();
  assert.equal(summaries.filter((summary) => summary.sessionId === "s39").length, 1);
  assert.equal(summaries.at(-1).title, "t2");

  forgetSessionCompletionSummary("s39");
  assert.equal(listSessionCompletionSummaries().some((summary) => summary.sessionId === "s39"), false);
});
