"use client";

import { useState } from "react";
import { getRelativeFilePath } from "@/lib/file-paths";

interface Props {
  fullPath: string;
  isDirectory: boolean;
  cwd: string;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  labels: {
    insertPath: string;
    mention: string;
    reveal: string;
    revealError: string;
  };
}

const actionStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 20,
  padding: "0 5px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-muted)",
  cursor: "pointer",
  textDecoration: "none",
} as const;

function RevealIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="M14 4h6v6" />
      <path d="m20 4-7 7" />
    </svg>
  );
}

/** 文件树条目的悬浮操作区，避免 TreeNode 继续承载具体操作状态和请求。 */
export function FileTreeNodeActions({ fullPath, isDirectory, cwd, onAtMention, labels }: Props) {
  const [revealing, setRevealing] = useState(false);

  const reveal = async () => {
    if (revealing) return;
    setRevealing(true);
    try {
      const response = await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("定位文件失败", { fullPath, error });
      window.alert(labels.revealError);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <span onClick={(event) => event.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      {onAtMention && (
        <button
          type="button"
          onClick={() => onAtMention(getRelativeFilePath(fullPath, cwd), isDirectory)}
          title={labels.insertPath}
          aria-label={labels.insertPath}
          style={{ ...actionStyle, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}
        >
          @{labels.mention}
        </button>
      )}
      <button
        type="button"
        onClick={reveal}
        disabled={revealing}
        title={labels.reveal}
        aria-label={labels.reveal}
        style={{ ...actionStyle, opacity: revealing ? 0.6 : 1 }}
      >
        <RevealIcon />
        <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{labels.reveal}</span>
      </button>
    </span>
  );
}
