"use client";

import { useCompletionNotification } from "@/hooks/useCompletionNotification";
import { useFloatingSessionNotifications } from "@/hooks/useFloatingSessionNotifications";

/** 组合系统通知与站内通知，但保持二者各自的状态边界。 */
export function useSessionNotifications(activeSessionId: string | null) {
  const floatingNotifications = useFloatingSessionNotifications(activeSessionId);
  const notificationController = useCompletionNotification({
    onNotification: floatingNotifications.enqueueNotification,
  });

  return {
    dismissNotification: floatingNotifications.dismissNotification,
    notificationController,
    notifications: floatingNotifications.notifications,
  };
}
