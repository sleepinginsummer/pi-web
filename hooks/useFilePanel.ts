"use client";

import { useCallback, useState } from "react";
import {
  closeFileTab,
  EMPTY_FILE_PANEL,
  openFileTab,
  type FilePanelState,
  type OpenFileOptions,
} from "@/lib/file-panel-model";

export function useFilePanel({ isMobile, onMobileOpen }: { isMobile: boolean; onMobileOpen: () => void }) {
  const [state, setState] = useState<FilePanelState>(EMPTY_FILE_PANEL);

  const openFile = useCallback((filePath: string, fileName: string, options?: OpenFileOptions) => {
    setState((current) => openFileTab(current, filePath, fileName, options));
    if (isMobile) onMobileOpen();
  }, [isMobile, onMobileOpen]);

  const closeTab = useCallback((tabId: string) => {
    setState((current) => closeFileTab(current, tabId));
  }, []);

  const clear = useCallback(() => setState(EMPTY_FILE_PANEL), []);
  const close = useCallback(() => setState((current) => ({ ...current, isOpen: false })), []);
  const open = useCallback(() => setState((current) => current.tabs.length > 0 ? { ...current, isOpen: true } : current), []);
  const toggle = useCallback(() => setState((current) => current.tabs.length > 0 ? { ...current, isOpen: !current.isOpen } : current), []);
  const selectTab = useCallback((tabId: string) => setState((current) => (
    current.tabs.some((tab) => tab.id === tabId) ? { ...current, activeTabId: tabId } : current
  )), []);

  return {
    activeTabId: state.activeTabId,
    clear,
    close,
    closeTab,
    isOpen: state.isOpen,
    open,
    openFile,
    selectTab,
    tabs: state.tabs,
    toggle,
  };
}
