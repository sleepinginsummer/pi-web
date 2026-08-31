"use client";

import { useEffect, useState, type CSSProperties } from "react";

type HostPlatform = "macos" | "windows" | "linux";

interface Props {
  fullPath: string;
  sourceSessionId?: string | null;
  labels: Record<HostPlatform, string>;
  errorLabel: string;
  showLabel?: boolean;
  className?: string;
  style?: CSSProperties;
}

let hostPlatformPromise: Promise<HostPlatform | null> | null = null;

function getHostPlatform(): Promise<HostPlatform | null> {
  if (!hostPlatformPromise) {
    hostPlatformPromise = fetch("/api/files/reveal")
      .then(async (response) => {
        if (!response.ok) return null;
        const data = await response.json() as { platform?: unknown };
        return data.platform === "macos" || data.platform === "windows" || data.platform === "linux"
          ? data.platform
          : null;
      })
      .catch(() => null);
  }
  return hostPlatformPromise;
}

function RevealIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="M14 4h6v6" />
      <path d="m20 4-7 7" />
    </svg>
  );
}

/** 统一处理在系统文件管理器中定位文件的请求与交互状态。 */
export function RevealFileButton({ fullPath, sourceSessionId, labels, errorLabel, showLabel = false, className, style }: Props) {
  const [hostPlatform, setHostPlatform] = useState<HostPlatform | null>(null);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    let active = true;
    void getHostPlatform().then((result) => {
      if (active) setHostPlatform(result);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!hostPlatform) return null;
  const label = labels[hostPlatform];

  const reveal = async () => {
    if (revealing) return;
    setRevealing(true);
    try {
      const response = await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath, sessionId: sourceSessionId ?? null }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("定位文件失败", { fullPath, error });
      window.alert(errorLabel);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={reveal}
      disabled={revealing}
      title={label}
      aria-label={label}
      className={className}
      style={{ ...style, opacity: revealing ? 0.6 : style?.opacity }}
    >
      <RevealIcon />
      {showLabel && <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>}
    </button>
  );
}
