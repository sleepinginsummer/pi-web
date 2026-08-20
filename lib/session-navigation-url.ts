export function replaceSessionUrl(sessionId: string | null): void {
  const url = new URL(window.location.href);
  if (sessionId) url.searchParams.set("session", sessionId);
  else url.searchParams.delete("session");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function getNotificationSessionId(target: string, origin: string): string | null {
  const url = new URL(target, origin);
  if (url.pathname !== "/") return null;
  return url.searchParams.get("session");
}
