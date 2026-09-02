export interface FloatingSessionNotification {
  sessionId: string;
  title: string;
  body: string;
  folderName?: string;
  url: string;
}

export function shouldQueueSessionNotification(
  activeSessionId: string | null,
  sessionId: string | null | undefined,
  showWhenActive = false,
): sessionId is string {
  return Boolean(sessionId && (showWhenActive || sessionId !== activeSessionId));
}

/** 同一会话只保留最新通知，并将最近更新的会话移到队首。 */
export function upsertFloatingSessionNotification(
  notifications: FloatingSessionNotification[],
  notification: FloatingSessionNotification,
): FloatingSessionNotification[] {
  return [
    notification,
    ...notifications.filter((item) => item.sessionId !== notification.sessionId),
  ];
}

export function dismissFloatingSessionNotification(
  notifications: FloatingSessionNotification[],
  sessionId: string,
): FloatingSessionNotification[] {
  const next = notifications.filter((item) => item.sessionId !== sessionId);
  return next.length === notifications.length ? notifications : next;
}

export function clearActiveFloatingSessionNotification(
  notifications: FloatingSessionNotification[],
  activeSessionId: string | null,
): FloatingSessionNotification[] {
  return activeSessionId
    ? dismissFloatingSessionNotification(notifications, activeSessionId)
    : notifications;
}

export function openFloatingSessionNotification(
  notification: FloatingSessionNotification,
  onDismiss: (sessionId: string) => void,
  onNavigate: (url: string) => void,
): void {
  onDismiss(notification.sessionId);
  onNavigate(notification.url);
}
