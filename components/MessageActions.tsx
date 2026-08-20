"use client";

import type { ReactNode } from "react";

export interface MessageAction {
  key: string;
  label: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

interface ForkActionOptions {
  creating: boolean;
  creatingLabel: string;
  creatingTitle: string;
  label: string;
  title: string;
  onClick: () => void;
}

export function CopyActionIcon({ copied }: { copied: boolean }) {
  return copied
    ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="20 6 9 17 4 12" /></svg>
    : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}

export function ForkActionIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>;
}

/** 统一用户和助手消息的“新会话”文案、图标与进行中状态。 */
export function createForkAction(options: ForkActionOptions): MessageAction {
  return {
    key: "fork",
    label: options.creating ? options.creatingLabel : options.label,
    title: options.creating ? options.creatingTitle : options.title,
    onClick: options.onClick,
    disabled: options.creating,
    active: options.creating,
    icon: <ForkActionIcon />,
  };
}

interface Props {
  actions: MessageAction[];
  visible: boolean;
}

/** 用户与助手消息共用的轻量动作栏；业务上的动作可用性由调用方决定。 */
export function MessageActions({ actions, visible }: Props) {
  if (actions.length === 0) return null;

  return (
    <div style={{
      display: "flex",
      gap: 3,
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? "auto" : "none",
      transition: "opacity 0.12s",
    }}>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            height: 22,
            background: "none",
            border: "none",
            borderRadius: 5,
            color: action.active ? "var(--accent)" : "var(--text-dim)",
            cursor: action.disabled ? "not-allowed" : "pointer",
            fontSize: 11,
            fontWeight: 400,
            whiteSpace: "nowrap",
            transition: "color 0.12s",
          }}
          onMouseEnter={(event) => { if (!action.disabled && !action.active) event.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(event) => { if (!action.active) event.currentTarget.style.color = "var(--text-dim)"; }}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  );
}
