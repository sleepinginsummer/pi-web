"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionTreeNode } from "@/lib/types";
import type { ShadowSessionControl } from "@/lib/shadow-session-control";
import type { SessionCopyField } from "@/lib/session-info-model";

export function useSessionPresentation({ closeTopPanel }: { closeTopPanel: () => void }) {
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [shadowControl, setShadowControl] = useState<ShadowSessionControl | null>(null);
  const [stats, setStats] = useState<SessionStatsInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [copiedField, setCopiedField] = useState<SessionCopyField | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const onBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeRef.current = onLeafChange;
  }, []);
  const onBranchLeafChange = useCallback((leafId: string | null) => branchLeafChangeRef.current?.(leafId), []);
  const onShadowControlChange = useCallback((control: ShadowSessionControl) => {
    setShadowControl((previous) => previous
      && previous.scopeKey === control.scopeKey
      && previous.sessionId === control.sessionId
      && previous.enabled === control.enabled
      && previous.pending === control.pending
      && previous.available === control.available
      && previous.onToggle === control.onToggle
      ? previous
      : control);
  }, []);
  const copySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopiedField(field);
      copyTimerRef.current = setTimeout(() => setCopiedField(null), 1400);
    });
  }, []);
  const updateStatsTitle = useCallback((sessionId: string, title: string) => {
    setStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
  }, []);
  const onStatsChange = useCallback((nextStats: SessionStatsInfo | null) => setStats(nextStats), []);
  const onSystemPromptChange = useCallback((prompt: string | null) => setSystemPrompt(prompt), []);
  const onContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => setContextUsage(usage), []);
  const reset = useCallback(() => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    closeTopPanel();
  }, [closeTopPanel]);

  return {
    branchActiveLeafId,
    branchTree,
    contextUsage,
    copiedField,
    copySessionField,
    onBranchDataChange,
    onBranchLeafChange,
    onContextUsageChange,
    onShadowControlChange,
    onStatsChange,
    onSystemPromptChange,
    reset,
    shadowControl,
    stats,
    systemPrompt,
    updateStatsTitle,
  };
}
