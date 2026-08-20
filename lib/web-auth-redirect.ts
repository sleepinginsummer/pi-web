export function getSafeInternalPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  const target = new URL(value, "http://localhost");
  if (target.pathname === "/login") return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}
