"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openNotificationTarget } from "@/lib/notification-navigation";

const STORAGE_KEY = "pi-notification-enabled";
const PROMPT_DISMISSED_KEY = "pi-notification-prompt-dismissed";
type CompletionNotificationPermission = NotificationPermission | "unsupported";
// 当前 TypeScript DOM 声明未包含已被浏览器实现的 renotify 标准选项。
type CompletionNotificationOptions = NotificationOptions & { renotify: boolean };

function getPermission(): CompletionNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function useCompletionNotification() {
  const [permission, setPermission] = useState<CompletionNotificationPermission>(getPermission);
  const [enabled, setEnabled] = useState(() => (
    typeof window !== "undefined"
    && localStorage.getItem(STORAGE_KEY) === "true"
    && getPermission() === "granted"
  ));
  const [showPrompt, setShowPrompt] = useState(() => (
    typeof window !== "undefined"
    && getPermission() === "default"
    && localStorage.getItem(PROMPT_DISMISSED_KEY) !== "true"
  ));
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);


  const toggle = useCallback(async () => {
    if (!("Notification" in window)) return;

    localStorage.setItem(PROMPT_DISMISSED_KEY, "true");
    setShowPrompt(false);

    if (enabledRef.current) {
      enabledRef.current = false;
      localStorage.setItem(STORAGE_KEY, "false");
      setEnabled(false);
      setPermission(Notification.permission);
      return;
    }

    const nextPermission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    setPermission(nextPermission);
    const nextEnabled = nextPermission === "granted";
    enabledRef.current = nextEnabled;
    localStorage.setItem(STORAGE_KEY, String(nextEnabled));
    setEnabled(nextEnabled);
  }, []);

  const dismissPrompt = useCallback(() => {
    localStorage.setItem(PROMPT_DISMISSED_KEY, "true");
    setShowPrompt(false);
  }, []);

  const notifySession = useCallback(async (title: string, body: string, sessionId?: string | null) => {
    if (!enabledRef.current || Notification.permission !== "granted") return;

    const url = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
    const options: CompletionNotificationOptions = {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: sessionId ? `pi-session-${sessionId}` : "pi-session-complete",
      // 同一会话复用 tag 时仍要求系统重新提示，避免完成通知只更新不提醒。
      renotify: true,
      data: { url },
    };

    try {
      const controllingWorker = "serviceWorker" in navigator
        ? navigator.serviceWorker.controller
        : null;
      if (controllingWorker) {
        // 后台页面可能延迟异步注册查询；已有 controller 时必须同步投递消息。
        controllingWorker.postMessage({ type: "SHOW_NOTIFICATION", title, options });
        return;
      }

      const registration = "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
      if (registration?.active) {
        registration.active.postMessage({ type: "SHOW_NOTIFICATION", title, options });
        return;
      }

      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        openNotificationTarget(url);
        notification.close();
      };
    } catch (error) {
      console.error("任务完成通知发送失败", error);
    }
  }, []);

  return {
    notificationEnabled: enabled,
    notificationPermission: permission,
    showNotificationPrompt: showPrompt,
    onNotificationToggle: toggle,
    dismissNotificationPrompt: dismissPrompt,
    notifySession,
  };
}

export type CompletionNotificationController = ReturnType<typeof useCompletionNotification>;
