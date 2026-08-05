export const NOTIFICATION_TARGET_EVENT = "pi:open-notification-target";

export interface NotificationTargetEventDetail {
  url: string;
}

/**
 * 将通知目标交给应用内导航处理；没有处理器接管时保留原有整页导航行为。
 */
export function openNotificationTarget(rawUrl: string): void {
  const targetUrl = new URL(rawUrl, window.location.origin);
  if (targetUrl.origin !== window.location.origin) return;

  const url = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  const event = new CustomEvent<NotificationTargetEventDetail>(NOTIFICATION_TARGET_EVENT, {
    cancelable: true,
    detail: { url },
  });
  if (window.dispatchEvent(event)) {
    window.location.assign(url);
  }
}
