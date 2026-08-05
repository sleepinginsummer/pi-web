import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookSource = await readFile(new URL("./useCompletionNotification.ts", import.meta.url), "utf8");
const serviceWorkerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const registrationSource = await readFile(new URL("../components/PwaRegistration.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

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
  assert.match(appShellSource, /window\.addEventListener\(NOTIFICATION_TARGET_EVENT/);
  assert.match(appShellSource, /notificationEvent\.preventDefault\(\)/);
  assert.match(appShellSource, /handleSelectSession\(info\)/);
  assert.doesNotMatch(registrationSource, /window\.location\.assign/);
  assert.doesNotMatch(hookSource, /window\.location\.assign/);
});

test("completion notifications are sent through the controlling service worker", () => {
  assert.doesNotMatch(hookSource, /document\.visibilityState/);
  assert.doesNotMatch(hookSource, /document\.hasFocus/);
  assert.match(hookSource, /activeWorker\.postMessage\(\{ type: "SHOW_NOTIFICATION", title, options \}\)/);
  assert.match(serviceWorkerSource, /event\.source\?\.id/);
  assert.match(serviceWorkerSource, /sourceClientId/);
  assert.match(serviceWorkerSource, /self\.registration\.showNotification\(title, notificationOptions\)/);
  assert.match(hookSource, /new Notification\(title, options\)/);
});

test("re-notifies when a session notification replaces the previous one", () => {
  assert.match(hookSource, /tag: sessionId \? `pi-session-\$\{sessionId\}`/);
  assert.match(hookSource, /renotify: true/);
});

test("exposes a session notification sender for completion and input requests", () => {
  assert.match(hookSource, /const notifySession = useCallback/);
  assert.match(hookSource, /notifySession,/);
});
