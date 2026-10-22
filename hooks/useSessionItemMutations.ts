"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";

/** archive 移入回收站（可恢复），permanent 直接删除文件。 */
export type SessionDeleteMode = "archive" | "permanent";
/** 确认条分两步：先选归档或删除，再对所选操作二次确认。 */
export type SessionDeleteStep = "choose" | SessionDeleteMode;

interface UseSessionItemMutationsOptions {
  session: SessionInfo;
  title: string;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onSwipeOpenChange: (open: boolean) => void;
}

export function useSessionItemMutations({
  session,
  title,
  onRenamed,
  onDeleted,
  onSwipeOpenChange,
}: UseSessionItemMutationsOptions) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteStep, setDeleteStep] = useState<SessionDeleteStep | null>(null);
  const confirmDelete = deleteStep !== null;
  const [deleting, setDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    const frameId = requestAnimationFrame(() => renameInputRef.current?.select());
    return () => cancelAnimationFrame(frameId);
  }, [renaming]);

  const beginRename = useCallback(() => {
    onSwipeOpenChange(false);
    setRenameValue(title);
    setRenaming(true);
  }, [onSwipeOpenChange, title]);

  const cancelRename = useCallback(() => setRenaming(false), []);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onRenamed?.();
    } catch (error) {
      console.error("重命名会话失败", error);
    }
  }, [onRenamed, renameValue, session.id, session.name, title]);

  const performDelete = useCallback(async (mode: SessionDeleteMode) => {
    setDeleteStep(null);
    setDeleting(true);
    try {
      const query = mode === "permanent" ? "?mode=permanent" : "";
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}${query}`, { method: "DELETE" });
      if (!response.ok) {
        console.error(`删除会话失败: HTTP ${response.status}`);
        return;
      }
      onDeleted?.(session.id);
    } catch (error) {
      console.error("删除会话失败", error);
    } finally {
      setDeleting(false);
    }
  }, [onDeleted, session.id]);

  const requestDelete = useCallback((skipToArchive = false) => {
    onSwipeOpenChange(false);
    // Shift+点击只省去选择这一步，归档仍要二次确认。
    setDeleteStep(skipToArchive ? "archive" : "choose");
  }, [onSwipeOpenChange]);

  const chooseDeleteMode = useCallback((mode: SessionDeleteMode) => setDeleteStep(mode), []);
  const backToDeleteChoice = useCallback(() => setDeleteStep("choose"), []);
  const cancelDelete = useCallback(() => setDeleteStep(null), []);

  return {
    renaming,
    renameValue,
    setRenameValue,
    renameInputRef,
    beginRename,
    cancelRename,
    commitRename,
    confirmDelete,
    deleteStep,
    deleting,
    requestDelete,
    chooseDeleteMode,
    backToDeleteChoice,
    cancelDelete,
    performDelete,
  };
}
