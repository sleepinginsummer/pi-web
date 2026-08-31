import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookSource = await readFile(new URL("./useCompletionNotification.ts", import.meta.url), "utf8");
const serviceWorkerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const registrationSource = await readFile(new URL("../components/PwaRegistration.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const notificationNavigationSource = await readFile(new URL("./useNotificationSessionNavigation.ts", import.meta.url), "utf8");
const sessionNotificationsSource = await readFile(new URL("./useSessionNotifications.ts", import.meta.url), "utf8");
const floatingNotificationsSource = await readFile(new URL("./useFloatingSessionNotifications.ts", import.meta.url), "utf8");
const backgroundCompletionSource = await readFile(new URL("./useBackgroundCompletionNotifications.ts", import.meta.url), "utf8");
const completionEffectsSource = await readFile(new URL("./useCompletionEffects.ts", import.meta.url), "utf8");

test("requests permission only from the explicit notification toggle", () => {
  assert.match(hookSource, /const toggle = useCallback\(async \(\) =>/);
  assert.match(hookSource, /await Notification\.requestPermission\(\)/);
  assert.ok(
    hookSource.indexOf("Notification.requestPermission()") > hookSource.indexOf("const toggle = useCallback"),
  );
});

test("shows the first-visit prompt only while permission is undecided", () => {
  assert.match(hookSource, /getPermission\(\) === "default"/);
  assert.match(hookSource, /PROMPT_DISMISSED_KEY/);
});

test("service worker notification click returns to the source window and target session", () => {
  assert.match(serviceWorkerSource, /notificationclick/);
  assert.match(serviceWorkerSource, /self\.clients\.get\(sourceClientId\)/);
  assert.match(serviceWorkerSource, /sourceClient\.focus\(\)/);
  assert.match(serviceWorkerSource, /sourceClient\.postMessage\(\{ type: "OPEN_NOTIFICATION_TARGET", url: targetUrl \}\)/);
  assert.doesNotMatch(serviceWorkerSource, /sourceClient\.navigate\(targetUrl\)/);
  assert.match(serviceWorkerSource, /self\.clients\.openWindow\(targetUrl\)/);
  assert.ok(
    serviceWorkerSource.indexOf("self.clients.get(sourceClientId)")
      < serviceWorkerSource.indexOf('self.clients.matchAll({ type: "window"'),
  );
});

test("notification target switches sessions without reloading the current page", () => {
  assert.match(registrationSource, /openNotificationTarget\(event\.data\.url\)/);
  assert.match(hookSource, /openNotificationTarget\(url\)/);
  assert.match(notificationNavigationSource, /window\.addEventListener\(NOTIFICATION_TARGET_EVENT/);
  assert.match(notificationNavigationSource, /notificationEvent\.preventDefault\(\)/);
  assert.match(notificationNavigationSource, /selectSession\(session\)/);
  assert.doesNotMatch(registrationSource, /window\.location\.assign/);
  assert.doesNotMatch(hookSource, /window\.location\.assign/);
});

test("completion notifications use the controlling service worker without waiting for registration lookup", () => {
  assert.doesNotMatch(hookSource, /document\.visibilityState/);
  assert.doesNotMatch(hookSource, /document\.hasFocus/);
  assert.match(hookSource, /const controllingWorker = [\s\S]*?navigator\.serviceWorker\.controller/);
  assert.match(hookSource, /controllingWorker\.postMessage\(\{ type: "SHOW_NOTIFICATION", title, options: notificationOptions \}\)/);
  assert.ok(
    hookSource.indexOf("controllingWorker.postMessage") < hookSource.indexOf("await navigator.serviceWorker.getRegistration()"),
  );
  assert.match(serviceWorkerSource, /event\.source\?\.id/);
  assert.match(serviceWorkerSource, /sourceClientId/);
  assert.match(serviceWorkerSource, /self\.registration\.showNotification\(title, notificationOptions\)/);
  assert.match(hookSource, /new Notification\(title, notificationOptions\)/);
});

test("re-notifies when a session notification replaces the previous one", () => {
  assert.match(hookSource, /tag: sessionId \? `pi-session-\$\{sessionId\}`/);
  assert.match(hookSource, /renotify: true/);
});

test("exposes a session notification sender for completion and input requests", () => {
  assert.match(hookSource, /const notifySession = useCallback/);
  assert.match(hookSource, /notifySession,/);
});

test("completion notifications explicitly allow the active session", () => {
  assert.match(completionEffectsSource, /notifySession\(title, body, completion\.sessionId, \{ showWhenActive: true \}\)/);
  assert.match(hookSource, /showWhenActive: policy\.showWhenActive/);
});

test("publishes the in-app intent independently of the system notification gate", () => {
  const permissionGate = hookSource.indexOf('if (!enabledRef.current || Notification.permission !== "granted") return');
  const intentDispatch = hookSource.indexOf("onNotificationRef.current?.({ title, body, sessionId, url, showWhenActive");
  assert.ok(intentDispatch >= 0 && permissionGate > intentDispatch);
});

test("AppShell only orchestrates the shared system and in-app notification controller", () => {
  assert.match(appShellSource, /useSessionNotifications\(selectedSession\?\.id \?\? null\)/);
  assert.match(appShellSource, /const \{ notifySession \} = notificationController/);
  assert.match(appShellSource, /notificationController=\{notificationController\}/);
  assert.match(appShellSource, /useBackgroundCompletionNotifications\(/);
  assert.match(backgroundCompletionSource, /for \(const sessionId of transition\.completedInBackground\)/);
  assert.match(backgroundCompletionSource, /notifySession\(title, body, sessionId\)/);
  assert.match(appShellSource, /<FloatingSessionNotifications/);
  assert.doesNotMatch(appShellSource, /useCompletionNotification\(/);
  assert.match(sessionNotificationsSource, /useCompletionNotification\(\{/);
  assert.match(sessionNotificationsSource, /useFloatingSessionNotifications\(activeSessionId\)/);
  assert.doesNotMatch(floatingNotificationsSource, /useCompletionNotification/);
  assert.doesNotMatch(chatWindowSource, /useCompletionNotification\(\)/);
  assert.doesNotMatch(hookSource, /pi-notification-setting-change/);
});
