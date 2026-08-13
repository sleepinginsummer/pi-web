"use client";

import { useEffect, useRef, useState } from "react";
import type { TodoItem } from "@/hooks/useAgentSession";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const STATUS_DOT_COLOR: Record<TodoItem["status"], string> = {
  pending: "var(--text-dim)",
  in_progress: "var(--accent)",
  completed: "#16a34a",
};

export function TodoListPanel({ todos, t }: { todos: TodoItem[]; t: Translate }) {
  const [expanded, setExpanded] = useState(false);

  const done = todos.filter((item) => item.status === "completed").length;
  const total = todos.length;
  const allDone = total > 0 && done === total;

  // 任务刚全部完成的瞬间自动折叠一次；之后用户仍可手动展开回顾整份计划。
  const prevAllDoneRef = useRef(allDone);
  useEffect(() => {
    if (allDone && !prevAllDoneRef.current) setExpanded(false);
    prevAllDoneRef.current = allDone;
  }, [allDone]);

  // 折叠态预览优先级：进行中 → 下一条待办 → 全部完成时最后一条。
  const active =
    todos.find((item) => item.status === "in_progress") ??
    todos.find((item) => item.status === "pending") ??
    (allDone ? todos[todos.length - 1] : undefined);

  const preview = allDone
    ? t("chat.todosAllDoneLast", { text: todos[todos.length - 1].subject })
    : active
      ? active.status === "in_progress"
        ? (active.activeForm || active.subject)
        : active.subject
      : "";

  return (
    <div
      role="status"
      aria-label={t("chat.todosTitle")}
      style={{
        width: "100%",
        margin: "0 0 16px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? t("chat.todosCollapse") : t("chat.todosExpand")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            color: "var(--accent)",
            flexShrink: 0,
          }}
        >
          {done}/{total}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: allDone ? "var(--text-dim)" : "var(--text-muted)",
          }}
        >
          {preview}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--text-dim)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
          aria-hidden="true"
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 7,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {todos.map((item) => (
            <div
              key={item.id}
              title={item.description}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 12,
                  textAlign: "center",
                  color: STATUS_DOT_COLOR[item.status],
                  fontWeight: item.status === "completed" ? 700 : 400,
                }}
              >
                {item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"}
              </span>
              <span
                style={{
                  minWidth: 0,
                  color:
                    item.status === "completed"
                      ? "var(--text-dim)"
                      : item.status === "in_progress"
                        ? "var(--text)"
                        : "var(--text-muted)",
                  textDecoration: item.status === "completed" ? "line-through" : "none",
                  overflowWrap: "anywhere",
                }}
              >
                {item.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
