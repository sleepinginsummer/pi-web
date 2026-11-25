"use client";

import { useState } from "react";
import { projectBadge } from "@/lib/project-badge";

/**
 * 项目图标：优先用项目自带的 favicon / app icon（`/api/project-icon`），
 * 没有图标时回落到「色块 + 项目名首字」。
 *
 * 置顶会话按项目合并后，组头用一个稳定的视觉标记区分目录。
 * 下方项目列表保留原有图标与加载行为。
 */

type ProjectIconStatus = "loading" | "ready" | "failed";

// 整页只探测一次同一个项目路径：图标接口是 no-store，重复请求没有任何收益。
const knownIconStatus = new Map<string, Exclude<ProjectIconStatus, "loading">>();
const KNOWN_STATUS_LIMIT = 256;

/** 置顶组图标的加载状态，失败结果在当前页面内复用。 */
function useProjectIcon(path: string): {
  status: ProjectIconStatus;
  onLoad: () => void;
  onError: () => void;
} {
  const [status, setStatus] = useState<ProjectIconStatus>(() => knownIconStatus.get(path) ?? "loading");
  const remember = (next: Exclude<ProjectIconStatus, "loading">) => {
    if (knownIconStatus.size >= KNOWN_STATUS_LIMIT) knownIconStatus.clear();
    knownIconStatus.set(path, next);
    setStatus(next);
  };
  return { status, onLoad: () => remember("ready"), onError: () => remember("failed") };
}

function iconQuery(path: string): string {
  return new URLSearchParams({ project: path }).toString();
}

export function ProjectMark({ path, name, size = 14 }: { path: string; name: string; size?: number }) {
  const badge = projectBadge(path, name);
  const icon = useProjectIcon(path);
  const hasIcon = icon.status === "ready";
  return (
    <span
      aria-hidden="true"
      data-session-project-mark={hasIcon ? "icon" : "letter"}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: Math.max(3, Math.round(size * 0.28)),
        background: hasIcon ? "transparent" : badge.background,
        color: badge.foreground,
        fontSize: Math.max(8, Math.round(size * 0.64)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {/* 图标还在加载时先显示首字占位，避免这一格忽有忽无。 */}
      {!hasIcon && badge.initial}
      {icon.status !== "failed" && (
        // 图标来自已授权的本地文件，不需要走 Next.js 的图片优化服务。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/project-icon?${iconQuery(path)}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          draggable={false}
          onLoad={icon.onLoad}
          onError={icon.onError}
          style={{ position: "absolute", inset: 0, objectFit: "contain", opacity: hasIcon ? 1 : 0 }}
        />
      )}
    </span>
  );
}
