import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionItem.tsx", import.meta.url), "utf8");
const mutationSource = await readFile(new URL("../hooks/useSessionItemMutations.ts", import.meta.url), "utf8");

test("only desktop Shift+click bypasses session deletion confirmation", () => {
  assert.match(source, /mutations\.requestDelete\(!isMobile && event\.shiftKey\)/);
  assert.match(mutationSource, /if \(skipConfirmation\) void performDelete\(\);\s*else setConfirmDelete\(true\);/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(source, /const handleKeyDown/);
  assert.doesNotMatch(source, /onKeyDown=\{handleKeyDown\}/);
});

test("keeps the pinned marker visible when a session is selected", () => {
  assert.match(source, /paddingRight: isPinned \? 32 : 8/);
  assert.match(source, /background: mutations\.confirmDelete \? "rgba\(239,68,68,0\.06\)" : isSelected/);
  assert.match(source, /background: "#eab308"[\s\S]*?borderBottomLeftRadius: 5/);
  assert.match(source, /PinIcon size=\{12\}[^>]*transform: "rotate\(45deg\)"/);
  assert.match(source, /PinIcon size=\{mobile \? 17 : 14\}/);
  assert.match(source, /aria-pressed=\{tone === "pin" \? pressed : undefined\}/);
});

test("prefills rename with the displayed title and exposes the desktop context menu", () => {
  assert.match(source, /const displayFirstMessage = parseSkillMessage\(session\.firstMessage\)\?\.displayText/);
  assert.match(mutationSource, /setRenameValue\(title\)/);
  assert.match(source, /dispatchSessionRowContextMenu\(/);
  assert.match(source, /onContextMenu=\{isMobile \|\| mutations\.confirmDelete \|\| mutations\.renaming \? undefined : handleContextMenu\}/);
});

test("未读标记保持静态，仅运行状态使用循环动画", () => {
  const runningIndicatorSource = source.slice(source.indexOf("function RunningSessionIndicator()"), source.indexOf("function UnreadSessionIndicator()"));
  const unreadIndicatorSource = source.slice(source.indexOf("function UnreadSessionIndicator()"), source.indexOf("function SessionDeleteConfirm("));
  assert.match(runningIndicatorSource, /repeatCount="indefinite"/);
  assert.doesNotMatch(unreadIndicatorSource, /<animate|repeatCount=/);
});
