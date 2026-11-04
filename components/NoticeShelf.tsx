"use client";

import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { splitNoticeText } from "@/lib/notice-text";

export interface NoticeShelfItem {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  exiting?: boolean;
  expanded?: boolean;
}

const COPIED_FEEDBACK_MS = 1_500;

interface NoticeShelfProps {
  notices: NoticeShelfItem[];
  copyLabel: string;
  copiedLabel: string;
  onToggleExpanded: (id: string, expanded: boolean) => void;
  floating?: boolean;
  copyNoticeText?: (text: string) => Promise<void>;
}

/** 点击展开并暂停自动消失，可复制完整内容；再次点击收起，重新计时后消失。 */
export function NoticeShelf({
  notices,
  copyLabel,
  copiedLabel,
  onToggleExpanded,
  floating = false,
  copyNoticeText = copyText,
}: NoticeShelfProps) {
  const [copiedNoticeId, setCopiedNoticeId] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copyNotice = (notice: NoticeShelfItem) => {
    void copyNoticeText(notice.message).then(() => {
      setCopiedNoticeId(notice.id);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedNoticeId(null), COPIED_FEEDBACK_MS);
    }).catch(() => undefined);
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
        const expanded = notice.expanded === true;
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            data-expanded={expanded ? "true" : undefined}
            style={{
              marginBottom: index === notices.length - 1 ? 0 : 6,
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
            }}
          >
            <button
              type="button"
              className="notice-shelf-toggle"
              aria-expanded={expanded}
              onClick={() => onToggleExpanded(notice.id, !expanded)}
            >
              <span className="notice-shelf-dot" style={{ background: color }} />
              <span className="notice-shelf-message">
                {splitNoticeText(notice.message).map((part, partIndex) => (
                  // 终端二维码或进度条（#755）：保留全部空格、行间无缝隙，并使用自带方块字符的等宽字体。
                  part.kind === "art"
                    ? <span key={partIndex} className="notice-shelf-art">{part.text}</span>
                    : part.text
                ))}
              </span>
            </button>
            {expanded && (
              <div className="notice-shelf-actions">
                <button type="button" className="notice-shelf-copy" onClick={() => copyNotice(notice)}>
                  {copiedNoticeId === notice.id ? copiedLabel : copyLabel}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
