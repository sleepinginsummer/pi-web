const WINDOWS_PATH_RE = /^(?:[a-z]:[\\/]|[\\/]{2})/i;

function normalizeLexicalPath(value: string, windows: boolean): string {
  const path = windows ? value.replace(/\\/g, "/") : value;
  const rooted = path.startsWith("/");
  const rootFloor = windows && /^[a-z]:(?:\/|$)/i.test(path) ? 1 : windows && path.startsWith("//") ? 2 : 0;
  const absolute = rooted || rootFloor > 0;
  const parts = path.split(/\/+/);
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length > rootFloor && normalized.at(-1) !== "..") normalized.pop();
      else if (!absolute) normalized.push(part);
      continue;
    }
    normalized.push(part);
  }

  const result = `${rooted ? "/" : ""}${normalized.join("/")}` || (rooted ? "/" : ".");
  return windows ? result.toLowerCase() : result;
}

/** 生成无 Node 依赖的路径身份键；浏览器可按路径形态识别 Windows 语义。 */
export function portablePathIdentity(value: string, windows = WINDOWS_PATH_RE.test(value)): string {
  return normalizeLexicalPath(value, windows);
}

export function samePortablePath(a: string, b: string, windows = WINDOWS_PATH_RE.test(a) || WINDOWS_PATH_RE.test(b)): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return portablePathIdentity(a, windows) === portablePathIdentity(b, windows);
}
