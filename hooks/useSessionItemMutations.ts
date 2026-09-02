"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";

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
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
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

  const requestDelete = useCallback((skipConfirmation = false) => {
    onSwipeOpenChange(false);
    if (skipConfirmation) void performDelete();
    else setConfirmDelete(true);
  }, [onSwipeOpenChange, performDelete]);

  const cancelDelete = useCallback(() => setConfirmDelete(false), []);

  return {
    renaming,
    renameValue,
    setRenameValue,
    renameInputRef,
    beginRename,
    cancelRename,
    commitRename,
    confirmDelete,
    deleting,
    requestDelete,
    cancelDelete,
    performDelete,
  };
}
