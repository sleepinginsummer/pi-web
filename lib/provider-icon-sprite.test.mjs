import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  DOMParser: { configurable: true, value: dom.window.DOMParser },
});

const originalFetch = globalThis.fetch;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PROVIDER_ICON_SPRITE_CONTAINER_ID,
  PROVIDER_ICON_SYMBOL_PREFIX,
  SERVER_PROVIDER_ICON_SPRITE_SNAPSHOT,
  ensureProviderIconSpriteLoaded,
  getProviderIconSpriteSnapshot,
  resetProviderIconSpriteForTests,
  resolveProviderIconHref,
  subscribeProviderIconSprite,
} = await jiti.import("./provider-icon-sprite.ts");

const SAMPLE_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg">
  <symbol id="openai" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>
  <symbol id="google" viewBox="0 0 24 24"><defs><linearGradient id="lobe-icons-google-"><stop offset="0%"/></linearGradient></defs><path fill="url(#lobe-icons-google-)" d="M0 0h24v24H0z"/></symbol>
</svg>`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetProviderIconSpriteForTests();
});

test("并发调用只请求一次 /provider-icons.svg，并把 symbol 注入页内隐藏容器复用", async () => {
  let fetchCount = 0;
  let resolveFetch;
  globalThis.fetch = () => {
    fetchCount += 1;
    return new Promise((resolve) => {
      resolveFetch = () => resolve(new Response(SAMPLE_SPRITE, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }));
    });
  };

  let notifications = 0;
  const unsubscribe = subscribeProviderIconSprite(() => { notifications += 1; });

  const first = ensureProviderIconSpriteLoaded();
  const second = ensureProviderIconSpriteLoaded();
  assert.equal(fetchCount, 1);
  assert.equal(resolveProviderIconHref("openai", getProviderIconSpriteSnapshot()), null);

  resolveFetch();
  await Promise.all([first, second]);
  unsubscribe();

  assert.equal(notifications, 1);
  const snapshot = getProviderIconSpriteSnapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(resolveProviderIconHref("openai", snapshot), `#${PROVIDER_ICON_SYMBOL_PREFIX}openai`);
  assert.equal(resolveProviderIconHref("google", snapshot), `#${PROVIDER_ICON_SYMBOL_PREFIX}google`);
  // 精灵表未收录的自定义符号回退到外链引用
  assert.equal(resolveProviderIconHref("custom-extra", snapshot), "/provider-icons.svg#custom-extra");

  const container = document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID);
  assert.ok(container);
  assert.equal(container.style.display, "");
  assert.equal(container.style.width, "0px");
  assert.equal(container.style.height, "0px");
  assert.ok(container.querySelector(`#${PROVIDER_ICON_SYMBOL_PREFIX}openai`));
  // 渐变 id 保持原样，不破坏 url(#lobe-icons-...) 引用
  assert.ok(container.querySelector("#lobe-icons-google-"));

  // 后续再次调用直接复用缓存，不再发网络请求
  await ensureProviderIconSpriteLoaded();
  assert.equal(fetchCount, 1);

  // 容器若意外被移除，从内存缓存同步补挂，也不再发网络请求
  container.remove();
  assert.equal(document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID), null);
  await ensureProviderIconSpriteLoaded();
  assert.equal(fetchCount, 1);
  assert.ok(document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID));
});

test("拉取失败或返回非 SVG 时降级为外链引用，SSR 快照保持外链引用", async () => {
  assert.equal(resolveProviderIconHref("openai", SERVER_PROVIDER_ICON_SPRITE_SNAPSHOT), "/provider-icons.svg#openai");

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("<html>login</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  await ensureProviderIconSpriteLoaded();
  assert.equal(fetchCount, 1);
  const snapshot = getProviderIconSpriteSnapshot();
  assert.equal(snapshot.status, "error");
  assert.equal(resolveProviderIconHref("openai", snapshot), "/provider-icons.svg#openai");

  // 失败状态不随滚动反复重试打爆网络
  await ensureProviderIconSpriteLoaded();
  assert.equal(fetchCount, 1);
});
