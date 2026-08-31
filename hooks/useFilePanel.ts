"use client";

import { useCallback, useState } from "react";
import {
  closeFileTab,
  EMPTY_FILE_PANEL,
  openFileTab,
  type FilePanelState,
  type OpenFileOptions,
} from "@/lib/file-panel-model";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { saveFileViewerState } from "@/components/file-tab-state";

type ViewerTab = FilePanelState["tabs"][number] & {
  viewerState?: FileViewerState;
  viewerRevision?: number;
};
type PanelState = Omit<FilePanelState, "tabs"> & { tabs: ViewerTab[] };

export function useFilePanel({ isMobile, onMobileOpen }: { isMobile: boolean; onMobileOpen: () => void }) {
  const [state, setState] = useState<PanelState>({ ...EMPTY_FILE_PANEL, tabs: [] });

  const openFile = useCallback((filePath: string, fileName: string, options?: OpenFileOptions) => {
    setState((current) => openFileTab(current, filePath, fileName, options) as PanelState);
    if (isMobile) onMobileOpen();
  }, [isMobile, onMobileOpen]);

  const closeTab = useCallback((tabId: string) => {
    setState((current) => closeFileTab(current, tabId) as PanelState);
  }, []);

  const clear = useCallback(() => setState(EMPTY_FILE_PANEL), []);
  const close = useCallback(() => setState((current) => ({ ...current, isOpen: false })), []);
  const open = useCallback(() => setState((current) => current.tabs.length > 0 ? { ...current, isOpen: true } : current), []);
  const toggle = useCallback(() => setState((current) => current.tabs.length > 0 ? { ...current, isOpen: !current.isOpen } : current), []);
  const selectTab = useCallback((tabId: string) => setState((current) => (
    current.tabs.some((tab) => tab.id === tabId) ? { ...current, activeTabId: tabId } : current
  )), []);
  const saveViewerState = useCallback((tabId: string, viewerRevision: number, viewerState: FileViewerState) => {
    setState((current) => ({
      ...current,
      tabs: saveFileViewerState(
        current.tabs as Parameters<typeof saveFileViewerState>[0],
        tabId,
        viewerRevision,
        viewerState,
      ) as ViewerTab[],
    }));
  }, []);

  return {
    activeTabId: state.activeTabId,
    clear,
    close,
    closeTab,
    isOpen: state.isOpen,
    open,
    openFile,
    selectTab,
    saveViewerState,
    tabs: state.tabs,
    toggle,
  };
}
