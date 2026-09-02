import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps local temporary notices in the chat shelf instead of the upstream top-right toast", () => {
  assert.match(source, /className="notice-shelf-overlay"[\s\S]*?<NoticeShelf notices=\{notices\} onDismiss=\{dismissNotice\} floating \/>/);
  assert.match(source, /<NoticeShelf notices=\{notices\} onDismiss=\{dismissNotice\} \/>/);
  assert.doesNotMatch(source, /top: 12,\s*right: 12/);
});

test("copies the complete notice on long press without dismissing it", () => {
  assert.match(source, /copyText\(notice\.message\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?longPressedRef\.current = true;[\s\S]*?\}, 500\)/);
  assert.match(source, /if \(longPressedRef\.current\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?return;/);
  assert.match(source, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(source, /copiedNoticeId === notice\.id \? t\("session\.copied"\) : notice\.message/);
});

test("connects update notices and written-file extraction to visible UI", () => {
  assert.match(source, /fetch\("\/api\/app-update"/);
  assert.match(source, /<NewSessionUpdateLink/);
  assert.match(source, /extractTurnWrittenFiles\([\s\S]*?turnContent\.slice\(0, contentLength\)[\s\S]*?toolResults,[\s\S]*?messageCwd/);
  assert.match(source, /const messageRenderIndex = useMemo\([\s\S]*?writtenFilesByFinalAssistant/);
  assert.match(source, /writtenFilesByFinalAssistant\.get\(finalAssistantIdx\)/);
  assert.match(source, /writtenFiles=\{options\.writtenFiles\}/);
});
