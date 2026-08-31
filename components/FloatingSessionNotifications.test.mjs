import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./FloatingSessionNotifications.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./FloatingSessionNotifications.module.css", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { openFloatingSessionNotification } = await jiti.import("../lib/floating-session-notifications.ts");

const notification = {
  sessionId: "session-1",
  title: "后台会话已完成",
  body: "任务结果已准备",
  url: "/?session=session-1",
};

test("通知 live region 常驻且可访问名称包含标题和正文", () => {
  assert.match(source, /role="region"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-label=\{openSessionLabel\(notification\.title, notification\.body\)\}/);
  assert.doesNotMatch(source, /notifications\.length === 0|createPortal/);
  assert.doesNotMatch(source, /FloatingSessionNotificationList|NotificationClassNames|classes=/);
});

test("打开操作先移除通知再导航", () => {
  const events = [];
  const onDismiss = (sessionId) => events.push(["dismiss", sessionId]);
  const onNavigate = (url) => events.push(["navigate", url]);

  openFloatingSessionNotification(notification, onDismiss, onNavigate);
  assert.deepEqual(events, [
    ["dismiss", "session-1"],
    ["navigate", "/?session=session-1"],
  ]);
});

test("通知固定在右上角并提供移动端、安全区和键盘焦点样式", () => {
  assert.match(styles, /\.stack\s*\{[\s\S]*?position: fixed;[\s\S]*?top: calc\(env\(safe-area-inset-top\) \+ 12px\);[\s\S]*?right:/);
  assert.match(styles, /\.contentButton:focus-visible/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
