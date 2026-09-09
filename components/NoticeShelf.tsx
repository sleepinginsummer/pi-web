"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";

export interface NoticeShelfItem {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  exiting?: boolean;
}

const LONG_PRESS_MS = 500;
const COPIED_FEEDBACK_MS = 1_500;

interface NoticeShelfProps {
  notices: NoticeShelfItem[];
  closeLabel: string;
  copiedLabel: string;
  onDismiss: (id: string) => void;
  floating?: boolean;
  copyNoticeText?: (text: string) => Promise<void>;
}

export function NoticeShelf({
  notices,
  closeLabel,
  copiedLabel,
  onDismiss,
  floating = false,
  copyNoticeText = copyText,
}: NoticeShelfProps) {
  const [copiedNoticeId, setCopiedNoticeId] = useState<string | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  }, []);

  useEffect(() => () => {
    clearPressTimer();
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [clearPressTimer]);

  const startLongPress = (notice: NoticeShelfItem) => {
    clearPressTimer();
    longPressedRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      void copyNoticeText(notice.message).then(() => {
        setCopiedNoticeId(notice.id);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopiedNoticeId(null), COPIED_FEEDBACK_MS);
      }).catch(() => undefined);
    }, LONG_PRESS_MS);
  };

  if (notices.length === 0) return null;
  return (
    <div className="notice-shelf" style={{ marginBottom: floating ? 0 : 10 }}>
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <button
            key={notice.id}
            type="button"
            onPointerDown={(event) => {
              if (event.button === 0) startLongPress(notice);
            }}
            onPointerUp={clearPressTimer}
            onPointerCancel={clearPressTimer}
            onPointerLeave={clearPressTimer}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              if (longPressedRef.current) {
                longPressedRef.current = false;
                event.preventDefault();
                return;
              }
              onDismiss(notice.id);
            }}
            aria-label={`${notice.message}，${closeLabel}`}
            className="notice-shelf-item"
            style={{
              marginBottom: index === notices.length - 1 ? 0 : 6,
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
            }}
          >
            <span className="notice-shelf-dot" style={{ background: color }} />
            <span className="notice-shelf-message">
              {copiedNoticeId === notice.id ? copiedLabel : notice.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}
