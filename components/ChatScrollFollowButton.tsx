"use client";

import styles from "./ChatScrollFollowButton.module.css";

interface Props {
  isMobile: boolean;
  label: string;
  onClick: () => void;
}

const DESKTOP_RIGHT_OFFSET = 44;

export function ChatScrollFollowButton({ isMobile, label, onClick }: Props) {
  return (
    <button
      type="button"
      className={styles.button}
      style={{
        right: isMobile
          ? 16
          : `max(${DESKTOP_RIGHT_OFFSET}px, calc((100% - 820px) / 2 + 16px))`,
      }}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 4v14" />
        <path d="m6 12 6 6 6-6" />
      </svg>
    </button>
  );
}
