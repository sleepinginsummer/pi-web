"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectTrustStatus } from "@/lib/api-types";
import { CwdRequestGate } from "@/lib/cwd-request-gate";

export function useProjectTrust({ cwd, onTrusted }: { cwd: string | null; onTrusted: () => void }) {
  const [status, setStatus] = useState<ProjectTrustStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gateRef = useRef<CwdRequestGate | null>(null);
  if (!gateRef.current) gateRef.current = new CwdRequestGate();
  useLayoutEffect(() => {
    gateRef.current?.setCwd(cwd);
  }, [cwd]);
  useEffect(() => {
    setStatus(null);
    setDialogOpen(false);
    setError(null);
    setBusy(false);
    if (!cwd) return;
    const ticket = gateRef.current!.begin(cwd);
    const controller = new AbortController();
    void fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (gateRef.current?.isCurrent(ticket)) setStatus(data);
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        if (gateRef.current?.isCurrent(ticket)) console.error("Failed to load project trust:", loadError);
      });
    return () => controller.abort();
  }, [cwd]);

  const openDialog = useCallback(() => {
    setError(null);
    setDialogOpen(true);
  }, []);
  const closeDialog = useCallback(() => {
    if (!busy) setDialogOpen(false);
  }, [busy]);
  const trust = useCallback(async () => {
    if (!cwd || busy) return;
    const ticket = gateRef.current!.begin(cwd);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!gateRef.current?.isCurrent(ticket)) return;
      setStatus(data);
      setDialogOpen(false);
      onTrusted();
    } catch (trustError) {
      if (gateRef.current?.isCurrent(ticket)) setError(trustError instanceof Error ? trustError.message : String(trustError));
    } finally {
      if (gateRef.current?.isCurrent(ticket)) setBusy(false);
    }
  }, [busy, cwd, onTrusted]);

  return { busy, closeDialog, dialogOpen, error, openDialog, status, trust };
}
