"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";

interface InputControlsMenuProps {
  isMobile: boolean;
  isOpen: boolean;
  modelControls: ReactNode;
  onClose: () => void;
  preferenceControls: ReactNode;
  runControls: ReactNode;
}

/** 输入控件菜单只负责弹层布局，具体控件及状态由调用方提供。 */
export function InputControlsMenu({
  isMobile,
  isOpen,
  modelControls,
  onClose,
  preferenceControls,
  runControls,
}: InputControlsMenuProps) {
  const { t } = useI18n();

  return (
    <div className={isMobile ? "mobile-controls-menu" : undefined} style={{
      display: isMobile ? (isOpen ? "flex" : "none") : "flex",
      alignItems: "center",
      gap: isMobile ? 1 : 2,
      ...(isMobile ? {
        position: "absolute",
        right: 0,
        bottom: 0,
        zIndex: 60,
        padding: 1,
        width: "min(320px, calc(100vw - 32px))",
        maxWidth: "calc(100vw - 32px)",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
        borderRadius: 10,
        background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
        boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
        backdropFilter: "blur(10px)",
      } : null),
    }}>
      {modelControls}
      {runControls}
      {isMobile && isOpen && <span data-controls-row-break="true" aria-hidden="true" style={{ flexBasis: "100%", height: 0 }} />}
      {preferenceControls}
      {isMobile && isOpen && (
        <button
          type="button"
          title={t("chat.collapseControls")}
          aria-label={t("chat.collapseControls")}
          aria-expanded={true}
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 32,
            padding: 0,
            marginLeft: 0,
            background: "var(--bg-hover)",
            border: "none",
            borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
            borderRadius: "0 9px 9px 0",
            color: "var(--text)",
            cursor: "pointer",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-selected)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
