/** Git 改动列表的显示方式（列表/树），记在当前浏览器。 */
const CHANGES_VIEW_MODE_STORAGE_KEY = "pi-web:sidebar-changes-view-mode";

export type ChangesViewMode = "list" | "tree";

export function loadChangesViewMode(): ChangesViewMode {
  if (typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(CHANGES_VIEW_MODE_STORAGE_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

export function saveChangesViewMode(mode: ChangesViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHANGES_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时只影响记忆，不影响当前显示。
  }
}
