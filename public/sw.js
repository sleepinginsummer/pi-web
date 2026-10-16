const CACHE_PREFIX = "pi-web";
const CACHE_VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
// A reachable port whose upstream is dead answers nothing; bound the wait so the offline page can show.
const NAVIGATION_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 8000;
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }

  if (event.data?.type === "SHOW_NOTIFICATION") {
    const sourceClientId = event.source?.id;
    const { title, options } = event.data;
    if (typeof title !== "string" || !options || typeof options !== "object") return;

    // 消息来源由浏览器提供，确保通知点击时能精确返回发送通知的窗口。
    const notificationOptions = {
      ...options,
      data: { ...options.data, sourceClientId },
    };
    event.waitUntil(
      self.registration.showNotification(title, notificationOptions).catch((error) => {
        console.error("任务完成通知发送失败", error);
      }),
    );
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let targetUrlValue = new URL("/", self.location.origin);
  try {
    const candidate = new URL(event.notification.data?.url || "/", self.location.origin);
    if (candidate.origin === self.location.origin) targetUrlValue = candidate;
  } catch {
    // Keep the root URL when notification data is malformed.
  }
  const targetUrl = targetUrlValue.href;
  const sourceClientId = event.notification.data?.sourceClientId;
  event.waitUntil((async () => {
    // 优先定位发送通知的原窗口，避免普通 Chrome 标签页抢占 PWA 通知。
    const sourceClient = typeof sourceClientId === "string"
      ? await self.clients.get(sourceClientId)
      : undefined;
    if (sourceClient && "focus" in sourceClient) {
      await sourceClient.focus();
      sourceClient.postMessage({ type: "OPEN_NOTIFICATION_TARGET", url: targetUrl });
      return;
    }

    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exactClient = clients.find((candidate) => candidate.url === targetUrl);
    if (exactClient) return exactClient.focus();
    const sameOriginClient = clients.find((candidate) => candidate.url.startsWith(self.location.origin));
    if (sameOriginClient) {
      const navigatedClient = await sameOriginClient.navigate(targetUrl);
      return (navigatedClient ?? sameOriginClient).focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Session data and live agent traffic must always come from the local server.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  // The manifest is runtime configuration. Bypass even entries left in an old
  // cache, including requests with a query string or navigation mode.
  if (url.pathname === "/manifest.webmanifest") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS).catch(async () => {
        const fallback = await caches.match(OFFLINE_URL);
        return fallback ?? Response.error();
      }),
    );
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith("/_next/static/") ||
    PRECACHE_URLS.includes(url.pathname);

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request, event));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requestedUrl = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : "/";
  let targetUrl = new URL("/", self.location.origin);
  try {
    const candidate = new URL(requestedUrl, self.location.origin);
    if (candidate.origin === self.location.origin) targetUrl = candidate;
  } catch {
    // Keep the root URL when notification data is malformed.
  }

  event.waitUntil(focusOrOpenWindow(targetUrl.href));
});

async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const exactClient = windowClients.find((client) => client.url === targetUrl);
  const candidates = exactClient
    ? [exactClient, ...windowClients.filter((client) => client !== exactClient)]
    : windowClients;

  for (const client of candidates) {
    try {
      const targetClient = client.url === targetUrl
        ? client
        : (await client.navigate(targetUrl)) ?? client;
      await targetClient.focus();
      return;
    } catch {
      // The window may have closed between matchAll and focus; try the next one.
    }
  }

  await self.clients.openWindow(targetUrl);
}

/**
 * Fetch with a ceiling on the wait for the response headers (time to first
 * byte). The timer is cleared as soon as they arrive, so a response that
 * streams a long body — Next.js streams SSR output — is never cut off
 * mid-stream.
 */
async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request, event) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetchWithTimeout(request, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    // Deliberately NOT awaited before returning the response.
    //
    // The SW script URL is versioned (?v=<app version>), so every upgrade
    // starts a fresh cache: the first load after an upgrade misses on every
    // chunk and writes them all at once. Awaiting each write here held every
    // response behind Cache Storage I/O, which stalled navigations past
    // NAVIGATION_TIMEOUT_MS — the browser showed the offline page while the
    // local server was perfectly healthy. waitUntil keeps this worker alive
    // until the write finishes without blocking the response.
    const copy = response.clone();
    event.waitUntil(
      caches
        .open(STATIC_CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => {
          // A failed write only costs one network re-fetch next time.
        }),
    );
  }
  return response;
}
