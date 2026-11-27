"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  ensureProviderIconSpriteLoaded,
  getProviderIconSpriteSnapshot,
  resolveProviderIconHref,
  SERVER_PROVIDER_ICON_SPRITE_SNAPSHOT,
  subscribeProviderIconSprite,
} from "@/lib/provider-icon-sprite";

/**
 * 返回 provider 图标的 <use href="..."> 引用地址：
 * 页内精灵表就绪后返回同文档 #id，避免虚拟滚动新挂载行重复校验外链 /provider-icons.svg。
 */
export function useProviderIconHref(symbol: string | undefined): string | null {
  const snapshot = useSyncExternalStore(
    subscribeProviderIconSprite,
    getProviderIconSpriteSnapshot,
    () => SERVER_PROVIDER_ICON_SPRITE_SNAPSHOT,
  );

  useEffect(() => {
    if (!symbol) return;
    void ensureProviderIconSpriteLoaded();
  }, [symbol]);

  if (!symbol) return null;
  return resolveProviderIconHref(symbol, snapshot);
}
