const CACHE_PREFIX = "pi-web";
const CACHE_VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
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
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
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
    const sameOriginClient = clients.find((candidate) => candidate.url.startsWith(self.location.origin));
    if (sameOriginClient) {
      await sameOriginClient.navigate(targetUrl);
      return sameOriginClient.focus();
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

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
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
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
