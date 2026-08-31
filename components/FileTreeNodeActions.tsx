"use client";

import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import { RevealFileButton } from "./RevealFileButton";

interface Props {
  fullPath: string;
  isDirectory: boolean;
  cwd: string;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  labels: {
    insertPath: string;
    download: string;
    mention: string;
    reveal: string;
    revealWindows: string;
    revealLinux: string;
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


/** 文件树条目的悬浮操作区，避免 TreeNode 继续承载具体操作状态和请求。 */
export function FileTreeNodeActions({ fullPath, isDirectory, cwd, onAtMention, labels }: Props) {
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
      {!isDirectory && (
        <a
          href={`/api/files/${encodeFilePathForApi(fullPath)}?type=download`}
          download
          title={labels.download}
          aria-label={labels.download}
          style={actionStyle}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      )}
      <RevealFileButton
        fullPath={fullPath}
        labels={{
          macos: labels.reveal,
          windows: labels.revealWindows,
          linux: labels.revealLinux,
        }}
        errorLabel={labels.revealError}
        showLabel
        style={actionStyle}
      />
    </span>
  );
}
