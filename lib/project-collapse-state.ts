const COLLAPSED_PROJECTS_STORAGE_KEY = "pi-web:collapsed-projects";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCollapsedProjects(
  storage: StorageLike | null = getBrowserStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const parsed = JSON.parse(storage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((path): path is string => typeof path === "string" && path.length > 0));
  } catch {
    return new Set();
  }
}

export function saveCollapsedProjects(
  projects: ReadonlySet<string>,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    if (projects.size === 0) storage.removeItem(COLLAPSED_PROJECTS_STORAGE_KEY);
    else storage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...projects]));
  } catch {
    // 浏览器隐私模式或存储配额异常不应阻断目录折叠。
  }
}
