"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

/** 团队名后的目录简称；悬浮或点按可查看完整路径，不触发团队展开/收起。 */
export function TeamDirectoryLabel({ cwd }: { cwd: string }) {
  const { t } = useI18n();
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const folder = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 });
  };

  useEffect(() => {
    if (!position) return;
    const close = () => { setPosition(null); setPinned(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node) && !tooltipRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);

  if (!cwd) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${t("teams.cwd")}：${cwd}`}
        aria-describedby={position ? tooltipId : undefined}
        aria-expanded={Boolean(position)}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }}
        onPointerLeave={() => { if (!pinned) setPosition(null); }}
        onFocus={show}
        onBlur={() => { setPosition(null); setPinned(false); }}
        onClick={() => {
          if (pinned) { setPosition(null); setPinned(false); }
          else { show(); setPinned(true); }
        }}
        style={{ border: 0, padding: 0, background: "transparent", color: "var(--text-dim)", fontSize: 10, cursor: "pointer", minWidth: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}
      >
        {folder}
      </button>
      {position && createPortal(
        <div ref={tooltipRef} id={tooltipId} role="tooltip" style={{ position: "fixed", ...position, width: "max-content", maxWidth: "min(280px, calc(100vw - 16px))", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, overflowWrap: "anywhere", zIndex: 1100 }}>
          {cwd}
        </div>, document.body,
      )}
    </>
  );
}
