import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const windowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const followSource = await readFile(new URL("./ChatScrollFollowButton.tsx", import.meta.url), "utf8");
const followCss = await readFile(new URL("./ChatScrollFollowButton.module.css", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useChatScrollFollow.ts", import.meta.url), "utf8");

test("长会话仅在脱离最新消息且没有待恢复滚动位置时显示返回按钮", () => {
  assert.match(windowSource, /!pendingScrollRestore && !isFollowingLatest && !isNearBottomLatest && \(\s*<ChatScrollFollowButton/);
  assert.match(windowSource, /onClick=\{\(\) => scrollToLatest\("smooth"\)\}/);
  assert.match(hookSource, /const \[isNearBottom, setIsNearBottom\] = useState\(true\)/);
});

test("按钮可键盘聚焦并避开桌面侧边小地图", () => {
  assert.match(followSource, /aria-label=\{label\}/);
  assert.match(followSource, /right: isMobile[\s\S]*?DESKTOP_RIGHT_OFFSET/);
  assert.match(followCss, /\.button:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(followCss, /@media \(prefers-reduced-motion: reduce\)/);
});
