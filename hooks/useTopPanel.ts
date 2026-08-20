"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TopPanel = "branches" | "system" | "session" | "language";
export interface TopPanelPosition { top: number; left: number; width: number }

const LANGUAGE_MENU_WIDTH = 176;

export function useTopPanel({ isMobile, onMobileOpen }: { isMobile: boolean; onMobileOpen: () => void }) {
  const [activePanel, setActivePanel] = useState<TopPanel | null>(null);
  const [position, setPosition] = useState<TopPanelPosition | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const languageButtonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setActivePanel(null), []);
  const open = useCallback((panel: TopPanel) => {
    if (isMobile) onMobileOpen();
    setActivePanel(panel);
  }, [isMobile, onMobileOpen]);
  const toggle = useCallback((panel: TopPanel) => {
    if (isMobile) onMobileOpen();
    setActivePanel((current) => current === panel ? null : panel);
  }, [isMobile, onMobileOpen]);

  useEffect(() => {
    const topBar = topBarRef.current;
    if (!activePanel || activePanel === "branches" || !topBar) {
      setPosition(null);
      return;
    }

    const update = () => {
      const topBarRect = topBar.getBoundingClientRect();
      const languageButton = languageButtonRef.current;
      if (activePanel === "language" && !isMobile && languageButton) {
        const buttonRect = languageButton.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(buttonRect.left - 1, Math.max(topBarRect.left, topBarRect.right - width));
        setPosition({ top: topBarRect.bottom, left, width });
        return;
      }
      setPosition({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(topBar);
    if (languageButtonRef.current) observer.observe(languageButtonRef.current);
    return () => observer.disconnect();
  }, [activePanel, isMobile]);

  return { activePanel, close, languageButtonRef, open, position, toggle, topBarRef };
}
