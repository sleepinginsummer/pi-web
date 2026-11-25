"use client";

import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import {
  resolveModelBrandIcon,
  type CompiledModelBrandIcons,
  type ModelBrandLookupInput,
  type ResolvedModelBrandIcon,
} from "@/lib/model-brand-icon";
import {
  ensureUserModelBrandIconsLoaded,
  getModelBrandIconsSnapshot,
  lookupModelDisplayName,
  registerModelDisplayNames,
  SERVER_BRAND_ICON_SNAPSHOT,
  subscribeModelBrandIcons,
} from "@/lib/model-brand-icon-store";

export { lookupModelDisplayName, registerModelDisplayNames };

export function useModelBrandIconsRegistry(): CompiledModelBrandIcons {
  const snapshot = useSyncExternalStore(
    subscribeModelBrandIcons,
    getModelBrandIconsSnapshot,
    () => SERVER_BRAND_ICON_SNAPSHOT,
  );
  useEffect(() => {
    ensureUserModelBrandIconsLoaded();
  }, []);
  return snapshot.compiled;
}

export function useResolvedModelBrandIcon(
  input: ModelBrandLookupInput | null | undefined,
): ResolvedModelBrandIcon | null {
  const compiled = useModelBrandIconsRegistry();
  if (!input) return null;
  const resolvedName = input.name ?? lookupModelDisplayName(input.provider, input.modelId);
  return resolveModelBrandIcon(
    resolvedName !== input.name ? { ...input, name: resolvedName } : input,
    compiled,
  );
}

interface ModelBrandIconProps {
  provider?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  name?: string | null;
  /** 已经提前解析好时可直接传入，避免重复匹配。 */
  resolved?: ResolvedModelBrandIcon | null;
  size?: number;
  title?: string;
  style?: CSSProperties;
}

export function ModelBrandIcon({
  provider,
  providerName,
  modelId,
  name,
  resolved,
  size = 14,
  title,
  style,
}: ModelBrandIconProps) {
  const compiled = useModelBrandIconsRegistry();
  const resolvedName = name ?? lookupModelDisplayName(provider, modelId);
  const icon = resolved !== undefined
    ? resolved
    : resolveModelBrandIcon({ provider, providerName, modelId, name: resolvedName }, compiled);

  if (!icon) return null;

  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: size,
    height: size,
    color: "var(--text-muted)",
    ...style,
  };

  if (icon.symbol) {
    return (
      <span
        data-model-brand-icon={icon.id}
        data-model-vendor={icon.vendor}
        title={title}
        aria-hidden={title ? undefined : true}
        style={wrapperStyle}
      >
        <svg
          aria-hidden="true"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill={icon.color ? undefined : "currentColor"}
          style={{ display: "block", flexShrink: 0 }}
        >
          <use href={`/provider-icons.svg#${icon.symbol}`} />
        </svg>
      </span>
    );
  }

  if (icon.src) {
    return (
      <span
        data-model-brand-icon={icon.id}
        data-model-vendor={icon.vendor}
        title={title}
        aria-hidden={title ? undefined : true}
        style={wrapperStyle}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={icon.src}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: "contain", display: "block", flexShrink: 0 }}
        />
      </span>
    );
  }

  return (
    <span
      data-model-brand-icon={icon.id}
      data-model-vendor={icon.vendor}
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        ...wrapperStyle,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        fontSize: Math.max(8, Math.floor(size * 0.5)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {icon.badge}
    </span>
  );
}
