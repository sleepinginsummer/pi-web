"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TopPanel = "agents" | "branches" | "system" | "tools" | "session" | "debug";
export interface TopPanelPosition { top: number; left: number; width: number }

const AGENT_PANEL_WIDTH = 420;

export function useTopPanel({ isMobile, onMobileOpen }: { isMobile: boolean; onMobileOpen: () => void }) {
  const [activePanel, setActivePanel] = useState<TopPanel | null>(null);
  const [position, setPosition] = useState<TopPanelPosition | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // The debug panel stays open across a session switch: it follows whichever session is shown.
  const close = useCallback(() => setActivePanel((current) => current === "debug" ? current : null), []);
  const closeDebug = useCallback(() => setActivePanel((current) => current === "debug" ? null : current), []);
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
    if (!activePanel || activePanel === "branches" || activePanel === "debug" || !topBar) {
      setPosition(null);
      return;
    }

    const update = () => {
      const topBarRect = topBar.getBoundingClientRect();
      if (activePanel === "agents") {
        setPosition({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setPosition({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(topBar);
    return () => observer.disconnect();
  }, [activePanel, isMobile]);

  return { activePanel, close, closeDebug, open, position, toggle, topBarRef };
}
