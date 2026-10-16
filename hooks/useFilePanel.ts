"use client";

import { useCallback, useRef, useState } from "react";
import {
  closeFileTab,
  EMPTY_FILE_PANEL,
  openFileTab,
  type FilePanelState,
  type OpenFileOptions,
} from "@/lib/file-panel-model";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { saveFileViewerState, saveParkedFileViewerState, switchFileWorkspace, type ParkedFileWorkspace } from "@/components/file-tab-state";

type ViewerTab = FilePanelState["tabs"][number] & {
  viewerState?: FileViewerState;
  viewerRevision?: number;
};
type PanelState = Omit<FilePanelState, "tabs"> & { tabs: ViewerTab[] };

export function useFilePanel({ isMobile, onMobileOpen }: { isMobile: boolean; onMobileOpen: () => void }) {
  const [state, setState] = useState<PanelState>({ ...EMPTY_FILE_PANEL, tabs: [] });
  const stateRef = useRef(state);
  stateRef.current = state;
  // 离开的项目暂存其文件标签，切回时恢复（#281 的项目隔离保持不变）。
  const parkedWorkspacesRef = useRef(new Map<string, ParkedFileWorkspace>());
  // 每次切换项目递增。正在卸载的查看器按渲染时的代数上报状态，避免写进另一个项目同路径的标签。
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const workspaceGenerationRef = useRef(0);

  const openFile = useCallback((filePath: string, fileName: string, options?: OpenFileOptions) => {
    setState((current) => openFileTab(current, filePath, fileName, options) as PanelState);
    if (isMobile) onMobileOpen();
  }, [isMobile, onMobileOpen]);

  const closeTab = useCallback((tabId: string) => {
    setState((current) => closeFileTab(current, tabId) as PanelState);
  }, []);

  const clear = useCallback(() => setState(EMPTY_FILE_PANEL), []);
  const close = useCallback(() => setState((current) => ({ ...current, isOpen: false })), []);
  const open = useCallback(() => setState((current) => ({ ...current, isOpen: true })), []);
  const toggle = useCallback(() => setState((current) => ({ ...current, isOpen: !current.isOpen })), []);
  const activateTab = useCallback((tabId: string) => setState((current) => ({
    ...current,
    activeTabId: tabId,
    isOpen: true,
  })), []);
  const selectTab = useCallback((tabId: string) => setState((current) => (
    current.tabs.some((tab) => tab.id === tabId) ? { ...current, activeTabId: tabId } : current
  )), []);
  const switchWorkspace = useCallback((currentKey: string | null, nextKey: string) => {
    if (currentKey === nextKey) return;
    const current = stateRef.current;
    const next = switchFileWorkspace(parkedWorkspacesRef.current, currentKey, nextKey, {
      tabs: current.tabs as Parameters<typeof switchFileWorkspace>[3]["tabs"],
      activeTabId: current.activeTabId,
      open: current.isOpen && current.tabs.length > 0,
    }, workspaceGenerationRef.current);
    workspaceGenerationRef.current += 1;
    setWorkspaceGeneration(workspaceGenerationRef.current);
    setState({ tabs: next.tabs as ViewerTab[], activeTabId: next.activeTabId, isOpen: next.open });
  }, []);

  const saveViewerState = useCallback((generation: number, tabId: string, viewerRevision: number, viewerState: FileViewerState) => {
    if (generation !== workspaceGenerationRef.current) {
      saveParkedFileViewerState(parkedWorkspacesRef.current, generation, tabId, viewerRevision, viewerState);
      return;
    }
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
    activateTab,
    clear,
    close,
    closeTab,
    isOpen: state.isOpen,
    open,
    openFile,
    selectTab,
    saveViewerState,
    switchWorkspace,
    tabs: state.tabs,
    toggle,
    workspaceGeneration,
  };
}
