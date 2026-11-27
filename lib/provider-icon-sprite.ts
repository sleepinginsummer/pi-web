const SVG_NS = "http://www.w3.org/2000/svg";

export const PROVIDER_ICON_SPRITE_PATH = "/provider-icons.svg";
export const PROVIDER_ICON_SPRITE_CONTAINER_ID = "pi-provider-icon-sprite";
export const PROVIDER_ICON_SYMBOL_PREFIX = "pi-provider-icon-";

export type ProviderIconSpriteStatus = "ssr" | "idle" | "loading" | "ready" | "error";

export interface ProviderIconSpriteSnapshot {
  status: ProviderIconSpriteStatus;
  symbols: ReadonlySet<string>;
}

const EMPTY_SYMBOLS: ReadonlySet<string> = new Set();

export const SERVER_PROVIDER_ICON_SPRITE_SNAPSHOT: ProviderIconSpriteSnapshot = {
  status: "ssr",
  symbols: EMPTY_SYMBOLS,
};

let currentSnapshot: ProviderIconSpriteSnapshot = {
  status: "idle",
  symbols: EMPTY_SYMBOLS,
};
let cachedSvgText: string | null = null;
let inFlightPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

/**
 * 生产环境携带构建版本号查询参数，升级后立即绕过旧 HTTP 缓存；
 * 开发环境保留原路径，修改 public/provider-icons.svg 后刷新即可看到最新图标。
 */
export function getProviderIconSpriteUrl(): string {
  const version = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (process.env.NODE_ENV === "production" && version) {
    return `${PROVIDER_ICON_SPRITE_PATH}?v=${encodeURIComponent(version)}`;
  }
  return PROVIDER_ICON_SPRITE_PATH;
}

export function subscribeProviderIconSprite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readMountedSpriteSymbols(): Set<string> | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID);
  if (!existing) return null;
  const symbols = new Set<string>();
  for (const el of Array.from(existing.querySelectorAll("symbol[id]"))) {
    const id = el.getAttribute("id") ?? "";
    if (id.startsWith(PROVIDER_ICON_SYMBOL_PREFIX)) {
      const symbolName = id.slice(PROVIDER_ICON_SYMBOL_PREFIX.length);
      if (symbolName) symbols.add(symbolName);
    }
  }
  return symbols.size > 0 ? symbols : null;
}

export function getProviderIconSpriteSnapshot(): ProviderIconSpriteSnapshot {
  if (currentSnapshot.status === "idle") {
    // HMR 重载模块后如果页面里已经挂着精灵表容器，直接复用，不再重复请求。
    const mountedSymbols = readMountedSpriteSymbols();
    if (mountedSymbols) {
      currentSnapshot = { status: "ready", symbols: mountedSymbols };
    }
  }
  return currentSnapshot;
}

function injectProviderIconSprite(svgText: string): Set<string> | null {
  if (typeof document === "undefined" || typeof DOMParser !== "function") return null;
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) return null;

  const parsedSymbols = Array.from(parsed.querySelectorAll("symbol"));
  if (parsedSymbols.length === 0) return null;

  const container = document.createElementNS(SVG_NS, "svg");
  container.setAttribute("id", PROVIDER_ICON_SPRITE_CONTAINER_ID);
  container.setAttribute("aria-hidden", "true");
  container.setAttribute("focusable", "false");
  // 不能用 display:none，否则带 <linearGradient> 的彩色图标在 Chrome/Safari 下无法渲染。
  container.style.position = "absolute";
  container.style.width = "0";
  container.style.height = "0";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";

  const loadedSymbols = new Set<string>();
  for (const symbol of parsedSymbols) {
    const rawId = symbol.getAttribute("id")?.trim();
    if (!rawId || loadedSymbols.has(rawId)) continue;
    const imported = document.importNode(symbol, true) as Element;
    imported.setAttribute("id", `${PROVIDER_ICON_SYMBOL_PREFIX}${rawId}`);
    container.appendChild(imported);
    loadedSymbols.add(rawId);
  }

  if (loadedSymbols.size === 0) return null;

  const existing = document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID);
  if (existing) existing.remove();

  const mountTarget = document.body ?? document.documentElement;
  if (!mountTarget) return null;
  mountTarget.appendChild(container);
  return loadedSymbols;
}

/**
 * 将 /provider-icons.svg 只拉取一次并注入页内隐藏 <svg> 精灵表。
 * 之后的虚拟滚动挂载全部通过同文档 #id 同步引用，避免每个新 <use> 节点重新校验外链 SVG。
 */
export function ensureProviderIconSpriteLoaded(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve();
  }

  if (currentSnapshot.status === "ready") {
    if (document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID)) {
      return Promise.resolve();
    }
    if (cachedSvgText) {
      const reinjected = injectProviderIconSprite(cachedSvgText);
      if (reinjected) {
        currentSnapshot = { status: "ready", symbols: reinjected };
        emitChange();
        return Promise.resolve();
      }
    }
  } else if (currentSnapshot.status === "idle") {
    const mountedSymbols = readMountedSpriteSymbols();
    if (mountedSymbols) {
      currentSnapshot = { status: "ready", symbols: mountedSymbols };
      emitChange();
      return Promise.resolve();
    }
  }

  if (inFlightPromise) return inFlightPromise;
  if (currentSnapshot.status === "error") return Promise.resolve();

  if (typeof fetch !== "function" || typeof DOMParser !== "function") {
    currentSnapshot = { status: "error", symbols: EMPTY_SYMBOLS };
    emitChange();
    return Promise.resolve();
  }

  currentSnapshot = { status: "loading", symbols: EMPTY_SYMBOLS };
  const request = fetch(getProviderIconSpriteUrl(), { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers?.get("content-type") ?? "";
      if (contentType.toLowerCase().includes("text/html")) {
        throw new Error("Unexpected HTML response for provider icon sprite");
      }
      const svgText = await response.text();
      const loadedSymbols = injectProviderIconSprite(svgText);
      if (!loadedSymbols) throw new Error("Provider icon sprite contained no valid symbols");
      cachedSvgText = svgText;
      currentSnapshot = { status: "ready", symbols: loadedSymbols };
      emitChange();
    })
    .catch(() => {
      // 拉取或解析失败时回退到外链引用，不中断界面渲染。
      currentSnapshot = { status: "error", symbols: EMPTY_SYMBOLS };
      emitChange();
    })
    .finally(() => {
      if (inFlightPromise === request) inFlightPromise = null;
    });

  inFlightPromise = request;
  return request;
}

/**
 * 解析 <use href="..."> 应使用的引用地址：
 * - 就绪且命中页内符号：返回同文档 fragment `#pi-provider-icon-<symbol>`（同步零请求）
 * - 客户端首次加载中：返回 null 占位，避免在精灵表到达前各行重复触发外链 SVG 请求
 * - SSR、加载失败或未收录的自定义符号：回退到外链 URL
 */
export function resolveProviderIconHref(
  symbol: string,
  snapshot: ProviderIconSpriteSnapshot,
): string | null {
  if (snapshot.status === "ready") {
    if (snapshot.symbols.has(symbol)) {
      return `#${PROVIDER_ICON_SYMBOL_PREFIX}${symbol}`;
    }
    return `${getProviderIconSpriteUrl()}#${symbol}`;
  }
  if (snapshot.status === "idle" || snapshot.status === "loading") {
    return null;
  }
  return `${getProviderIconSpriteUrl()}#${symbol}`;
}

export function resetProviderIconSpriteForTests(): void {
  currentSnapshot = { status: "idle", symbols: EMPTY_SYMBOLS };
  cachedSvgText = null;
  inFlightPromise = null;
  listeners.clear();
  if (typeof document !== "undefined") {
    document.getElementById(PROVIDER_ICON_SPRITE_CONTAINER_ID)?.remove();
  }
}
