export interface FileTab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
}

export interface OpenFileOptions {
  modeHint?: "diff";
  sourceSessionId?: string | null;
}

export interface FilePanelState {
  activeTabId: string | null;
  isOpen: boolean;
  tabs: FileTab[];
}

export const EMPTY_FILE_PANEL: FilePanelState = { activeTabId: null, isOpen: false, tabs: [] };

export function openFileTab(
  state: FilePanelState,
  filePath: string,
  fileName: string,
  options: OpenFileOptions = {},
): FilePanelState {
  const tabId = `file:${filePath}`;
  const existing = state.tabs.find((tab) => tab.id === tabId);
  const tabs = existing
    ? state.tabs.map((tab) => tab.id !== tabId ? tab : {
      ...tab,
      ...(options.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
      ...(options.modeHint ? { initialDisplayMode: options.modeHint } : {}),
    })
    : [...state.tabs, {
      id: tabId,
      label: fileName,
      filePath,
      sourceSessionId: options.sourceSessionId,
      initialDisplayMode: options.modeHint,
    }];
  return { tabs, activeTabId: tabId, isOpen: true };
}

export function closeFileTab(state: FilePanelState, tabId: string): FilePanelState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { ...state, tabs };
  const replacement = tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null;
  return { tabs, activeTabId: replacement, isOpen: tabs.length > 0 };
}
