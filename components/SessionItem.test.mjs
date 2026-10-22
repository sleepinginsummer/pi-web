import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionItem.tsx", import.meta.url), "utf8");
const mutationSource = await readFile(new URL("../hooks/useSessionItemMutations.ts", import.meta.url), "utf8");

test("Shift+click 只跳过选择步骤，归档仍需二次确认", () => {
  assert.match(source, /mutations\.requestDelete\(!isMobile && event\.shiftKey\)/);
  assert.match(mutationSource, /setDeleteStep\(skipToArchive \? "archive" : "choose"\);/);
  assert.doesNotMatch(mutationSource, /if \(skip\w*\) void performDelete/);
});

test("删除确认条先选归档或删除，再对所选操作二次确认", () => {
  const confirmSource = source.slice(source.indexOf("function SessionDeleteConfirm("), source.indexOf("function SessionRenameInput("));
  // 第一步只切换步骤，不执行删除。
  assert.match(confirmSource, /onClick=\{\(\) => onChoose\("archive"\)\}/);
  assert.match(confirmSource, /onClick=\{\(\) => onChoose\("permanent"\)\}/);
  assert.match(confirmSource, /onClick=\{\(\) => onConfirm\(step\)\}/);
  assert.match(confirmSource, /label=\{t\("sidebar\.back"\)\} onClick=\{onBack\}/);
  assert.match(source, /onChoose=\{mutations\.chooseDeleteMode\} onConfirm=\{\(mode\) => void mutations\.performDelete\(mode\)\}/);
  assert.match(mutationSource, /mode === "permanent" \? "\?mode=permanent" : ""/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(source, /const handleKeyDown/);
  assert.doesNotMatch(source, /onKeyDown=\{handleKeyDown\}/);
});

test("置顶装饰标记在桌面选中和悬浮时保持置顶显示", () => {
  assert.match(source, /paddingRight: isPinned \? 32 : 8/);
  assert.match(source, /background: mutations\.confirmDelete \? "rgba\(239,68,68,0\.06\)" : isSelected/);
  assert.match(source, /isPinned && <span data-session-pin-marker/);
  assert.match(source, /data-session-pin-marker[\s\S]*?zIndex: 3/);
  assert.match(source, /background: "#eab308"[\s\S]*?borderBottomLeftRadius: 5/);
  assert.match(source, /PinIcon size=\{12\}[^>]*transform: "rotate\(45deg\)"/);
  assert.match(source, /PinIcon size=\{mobile \? 17 : 14\}/);
  assert.match(source, /aria-pressed=\{tone === "pin" \? pressed : undefined\}/);
  assert.match(source, /paddingRight: !isMobile \? DESKTOP_SESSION_ACTIONS_WIDTH \+ 8 : 0/);
  assert.match(source, /pointerEvents: hovered \|\| isSelected \? "auto" : "none"/);
});


test("置顶按钮切换桌面布局后仍保留左边框", () => {
  assert.doesNotMatch(source, /borderLeft: mobile/);
  assert.match(source, /boxShadow: mobile \? "inset 1px 0 var\(--border\)" : undefined/);
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

test("停在扩展对话框上的运行用琥珀色呼吸圆点替换运行动画", () => {
  const awaitingSource = source.slice(source.indexOf("function AwaitingInputSessionIndicator()"), source.indexOf("function UnreadSessionIndicator()"));
  assert.match(awaitingSource, /title=\{t\("sidebar\.awaitingInput"\)\}/);
  assert.match(awaitingSource, /color: "#d97706"/);
  assert.match(awaitingSource, /<animate attributeName="opacity"[^>]*dur="1\.6s"[^>]*repeatCount="indefinite"/);
  // 仍是运行中的行：只替换指示器，其余运行态行为不变。
  assert.match(source, /isRunning && isAwaitingInput \? <AwaitingInputSessionIndicator \/> : isRunning \? <RunningSessionIndicator \/>/);
});

test("桌面端带修饰键或中键点击会话行时在新标签页打开", () => {
  assert.match(source, /import \{ isPlainActivation, sessionDeepLink \} from "@\/lib\/session-links";/);
  assert.match(source, /if \(!isMobile && !session\.transient && !isPlainActivation\(event\)\) \{\s*event\.preventDefault\(\);\s*openInNewTab\(\);/);
  assert.match(source, /if \(event\.button !== 1 \|\| isMobile \|\| session\.transient/);
  assert.match(source, /window\.open\(new URL\(sessionDeepLink\(session\.id\), window\.location\.href\)\.toString\(\), "_blank", "noopener"\)/);
  assert.match(source, /onAuxClick=\{handleRowAuxClick\}/);
});
