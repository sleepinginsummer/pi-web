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

  if (!isMobile) return <div style={{ display: "flex", alignItems: "center", gap: 2 }}>{modelControls}{runControls}{preferenceControls}</div>;
  if (!isOpen) return null;

  return (
    <div className="mobile-controls-menu" role="group" aria-label={t("chat.moreControls")} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      // 暂存库是弹在菜单里的原生 <dialog>：Esc 归它自己的 onCancel 处理，
      // 这里再收一次会把它连菜单一起卸载掉。
      if ((event.target as Element | null)?.closest?.("dialog")) return;
      event.stopPropagation();
      onClose();
    }}>
      <div className="mobile-controls-actions">
        {modelControls}
        {runControls}
      </div>
      <div className="mobile-controls-preferences">
        {preferenceControls}
        <button type="button" className="mobile-controls-close" aria-label={t("chat.collapseControls")} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
