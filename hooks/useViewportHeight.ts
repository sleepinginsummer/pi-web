"use client";

import { useEffect, useState } from "react";

interface ViewportHeightState {
  hasFocusedEditable: boolean;
  innerHeight: number;
  viewportHeight: number;
  viewportScale: number;
}

export function shouldUseVisualViewportHeight({
  hasFocusedEditable,
  innerHeight,
  viewportHeight,
  viewportScale,
}: ViewportHeightState): boolean {
  const isUnscaled = Math.abs(viewportScale - 1) < 0.01;
  return hasFocusedEditable && isUnscaled && innerHeight - viewportHeight > 1;
}

function hasFocusedEditableElement(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;

  return activeElement.isContentEditable
    || activeElement.tagName === "INPUT"
    || activeElement.tagName === "SELECT"
    || activeElement.tagName === "TEXTAREA";
}

/**
 * Keep the app height aligned with the visual viewport while a mobile keyboard
 * is open. iOS standalone PWAs can leave 100dvh at the layout viewport height,
 * which puts the composer behind the keyboard and may scroll the page itself.
 */
export function useViewportHeight(): number | null {
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let animationFrame = 0;

    const update = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        setViewportHeight(window.innerHeight);
        if (!viewport) return;

        const keyboardOpen = shouldUseVisualViewportHeight({
          hasFocusedEditable: hasFocusedEditableElement(),
          innerHeight: window.innerHeight,
          viewportHeight: viewport.height,
          viewportScale: viewport.scale,
        });
        if (keyboardOpen) {
          root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
          if (window.scrollX !== 0 || window.scrollY !== 0) {
            window.scrollTo(0, 0);
          }
        } else {
          root.style.removeProperty("--app-viewport-height");
        }
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);

  return viewportHeight;
}
