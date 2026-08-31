import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps local temporary notices in the chat shelf instead of the upstream top-right toast", () => {
  assert.match(source, /className="notice-shelf-overlay"[\s\S]*?<NoticeShelf notices=\{notices\} onDismiss=\{dismissNotice\} floating \/>/);
  assert.match(source, /<NoticeShelf notices=\{notices\} onDismiss=\{dismissNotice\} \/>/);
  assert.doesNotMatch(source, /top: 12,\s*right: 12/);
});
