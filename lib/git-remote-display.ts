/** 从常见 HTTPS/SSH/SCP 风格 remote URL 提取仓库 owner，仅用于界面标签。 */
export function getRemoteOwner(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scpMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  const path = scpMatch?.[1] ?? (() => {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ssh:") return null;
      return url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  })();
  if (!path) return null;
  const segments = path.split("/").filter(Boolean);
  return segments.length >= 2 ? segments.at(-2)! : null;
}

/** 将真实 Git 引用 remote/branch 转换为仅供展示的 owner/branch。 */
export function getUpstreamDisplayBranch(
  upstream: string,
  remoteUrlByName: ReadonlyMap<string, string>,
): string {
  const separator = upstream.indexOf("/");
  if (separator < 1) return upstream;
  const remote = upstream.slice(0, separator);
  const branch = upstream.slice(separator + 1);
  const owner = getRemoteOwner(remoteUrlByName.get(remote) ?? "");
  return owner ? `${owner}/${branch}` : upstream;
}
