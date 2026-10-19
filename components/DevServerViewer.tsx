"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { browserServerUrl, isDevServerActive } from "@/hooks/useDevServers";
import type { DevServerLogLine, DevServerSnapshot } from "@/lib/types";

const POLL_MS = 1500;

/**
 * A dev server in the right panel: its page in a frame while it runs, or its
 * output. The page is another origin (another port), so it cannot reach Pi
 * Web; the sandbox still drops same-origin rights if it shares Pi Web's.
 */
export function DevServerViewer({ serverId, fallbackLabel }: { serverId: string; fallbackLabel: string }) {
  const { t } = useI18n();
  const [server, setServer] = useState<DevServerSnapshot | null>(null);
  const [lines, setLines] = useState<DevServerLogLine[]>([]);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<"preview" | "logs">("preview");
  const [frameKey, setFrameKey] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/logs?lines=500`, { cache: "no-store" });
        if (stopped) return;
        if (response.status === 404) {
          setMissing(true);
          return;
        }
        const data = await response.json() as { server?: DevServerSnapshot; lines?: DevServerLogLine[] };
        if (data.server) setServer(data.server);
        if (data.lines) setLines(data.lines);
      } catch {
        // Keep the last snapshot; the next poll retries.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverId]);

  useEffect(() => {
    const element = logRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lines, mode]);

  const url = server?.url ? browserServerUrl(server.url) : undefined;
  const canPreview = Boolean(url && server?.status === "running");
  const effectiveMode = canPreview ? mode : "logs";
  const sameOrigin = useMemo(() => {
    if (!url || typeof window === "undefined") return false;
    try {
      return new URL(url).origin === window.location.origin;
    } catch {
      return false;
    }
  }, [url]);

  if (missing) {
    return <div className="dev-server-viewer-empty">{t("servers.gone")}</div>;
  }
  // Nothing to show before the first poll answers.
  if (!server) return <div className="dev-server-viewer-empty" />;

  const name = server?.name ?? fallbackLabel;
  return (
    <div className="dev-server-viewer">
      <div className="dev-server-viewer-toolbar">
        <span className={`dev-server-dot is-${server?.status ?? "starting"}`} aria-hidden="true" />
        <span className="dev-server-viewer-url" title={url ?? name}>{url ?? name}</span>
        <div className="dev-server-viewer-tabs" role="group" aria-label={name}>
          <button
            type="button"
            aria-pressed={effectiveMode === "preview"}
            disabled={!canPreview}
            onClick={() => setMode("preview")}
          >
            {t("servers.preview")}
          </button>
          <button type="button" aria-pressed={effectiveMode === "logs"} onClick={() => setMode("logs")}>
            {t("servers.logs")}
          </button>
        </div>
        {effectiveMode === "preview" && (
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("servers.reload")}
            aria-label={t("servers.reload")}
            onClick={() => setFrameKey((key) => key + 1)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>
          </button>
        )}
        {url && canPreview && (
          <a
            className="file-viewer-icon-button"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={t("servers.openExternal")}
            aria-label={t("servers.openExternal")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
          </a>
        )}
      </div>
      {server && !isDevServerActive(server) && (
        <div className="dev-server-viewer-notice" role="status">
          {t("servers.notRunning", { name, status: t(`servers.status.${server.status}`) })}
          {server.error ? ` ${server.error}` : ""}
        </div>
      )}
      {effectiveMode === "preview" && url ? (
        <iframe
          key={frameKey}
          className="dev-server-viewer-frame"
          src={url}
          title={t("servers.tabLabel", { name })}
          sandbox={sameOrigin
            ? "allow-scripts allow-forms allow-popups allow-modals"
            : "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"}
        />
      ) : (
        <pre
          ref={logRef}
          className="dev-server-viewer-logs"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
        >
          {lines.length === 0
            ? t("servers.noLogs")
            : lines.map((line, index) => (
                <span key={`${line.time}-${index}`} className={`dev-server-log-${line.stream}`}>{line.text}{"\n"}</span>
              ))}
        </pre>
      )}
    </div>
  );
}
