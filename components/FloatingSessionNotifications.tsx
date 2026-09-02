"use client";

import {
  openFloatingSessionNotification,
  type FloatingSessionNotification,
} from "@/lib/floating-session-notifications";
import styles from "./FloatingSessionNotifications.module.css";

interface FloatingSessionNotificationsProps {
  notifications: FloatingSessionNotification[];
  closeLabel: string;
  regionLabel: string;
  openSessionLabel: (title: string, body: string) => string;
  onDismiss: (sessionId: string) => void;
  onNavigate: (url: string) => void;
}

/** 常驻渲染 live region，确保首条通知也是已有区域的内容更新。 */
export function FloatingSessionNotifications({
  notifications,
  closeLabel,
  regionLabel,
  openSessionLabel,
  onDismiss,
  onNavigate,
}: FloatingSessionNotificationsProps) {
  return (
    <section
      className={styles.stack}
      role="region"
      aria-label={regionLabel}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {notifications.map((notification) => (
        <article className={styles.notification} key={notification.sessionId}>
          <button
            type="button"
            className={styles.contentButton}
            aria-label={openSessionLabel(
              [notification.folderName, notification.title].filter(Boolean).join(" "),
              notification.body,
            )}
            onClick={() => openFloatingSessionNotification(notification, onDismiss, onNavigate)}
          >
            {notification.folderName && (
              <span className={styles.folderName}>{notification.folderName}</span>
            )}
            <span className={styles.title}>{notification.title}</span>
            <span className={styles.body}>{notification.body}</span>
          </button>
          <button
            type="button"
            className={styles.closeButton}
            aria-label={`${closeLabel}: ${notification.title}`}
            title={closeLabel}
            onClick={() => onDismiss(notification.sessionId)}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </article>
      ))}
    </section>
  );
}
