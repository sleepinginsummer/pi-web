"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { browserServerUrl, isDevServerActive, useDevServers } from "@/hooks/useDevServers";
import type { DevServerSnapshot } from "@/lib/types";

function hostLabel(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/**
 * The bottom bar's dev server entry: a trigger like an extension widget's,
 * opening the project's server list. Shown once the project has a server this
 * pi-web process started (running or finished) or a launch file that failed to
 * parse; declared servers that never ran are listed inside it but do not make
 * it appear.
 */
export function DevServersShelf({
  cwd,
  onOpenPreview,
}: {
  cwd: string | null | undefined;
  onOpenPreview?: (serverId: string, label: string) => void;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { data, error, pending, start, stop, dismiss } = useDevServers(cwd);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!data) return null;
  const servers = data.servers;
  const activeNames = new Set(servers.filter(isDevServerActive).map((server) => server.name));
  const declared = data.enabled ? data.configs.filter((config) => !activeNames.has(config.name)) : [];
  // 只有本进程启动过的服务器或启动配置错误才显示入口；仅声明过 launch 配置不显示。
  if (servers.length === 0 && data.errors.length === 0) return null;

  const runningCount = servers.filter(isDevServerActive).length;
  // 启动配置有问题时入口带告警红点，读屏用带错误的文案，不占用运行计数。
  const hasErrors = data.errors.length > 0;
  const label = hasErrors
    ? t("servers.triggerErrors")
    : runningCount > 0
      ? t("servers.triggerLabel", { count: runningCount })
      : t("servers.title");

  const renderServer = (server: DevServerSnapshot) => {
    const active = isDevServerActive(server);
    const busy = pending.has(server.id) || server.status === "stopping";
    const url = server.url ? browserServerUrl(server.url) : undefined;
    return (
      <li key={server.id} className={`dev-server-row is-${server.status}`}>
        <span className="dev-server-dot" aria-hidden="true" />
        <span className="dev-server-name" title={server.command ?? server.name}>{server.name}</span>
        <span className="dev-server-meta">
          {server.status === "running" && url ? hostLabel(server.url) : t(`servers.status.${server.status}`)}
          {!server.managed && ` · ${t("servers.attached")}`}
        </span>
        <span className="dev-server-actions">
          {onOpenPreview && (
            <button
              type="button"
              className="dev-server-action"
              title={server.status === "running" && url ? t("servers.preview") : t("servers.logs")}
              aria-label={`${server.status === "running" && url ? t("servers.preview") : t("servers.logs")} ${server.name}`}
              onClick={() => {
                onOpenPreview(server.id, server.name);
                setOpen(false);
              }}
            >
              {server.status === "running" && url
                ? <svg {...iconProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
                : <svg {...iconProps}><path d="M4 6h16M4 12h16M4 18h10" /></svg>}
            </button>
          )}
          {url && server.status === "running" && (
            <a
              className="dev-server-action"
              href={url}
              target="_blank"
              rel="noreferrer"
              title={t("servers.openExternal")}
              aria-label={`${t("servers.openExternal")} ${server.name}`}
            >
              <svg {...iconProps}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
            </a>
          )}
          {active ? (
            <button
              type="button"
              className="dev-server-action is-danger"
              disabled={busy}
              title={t("servers.stop")}
              aria-label={`${t("servers.stop")} ${server.name}`}
              onClick={() => void stop(server.id)}
            >
              <svg {...iconProps}><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            </button>
          ) : (
            <button
              type="button"
              className="dev-server-action"
              disabled={busy}
              title={t("servers.dismiss")}
              aria-label={`${t("servers.dismiss")} ${server.name}`}
              onClick={() => {
                // 移除最后一项时先收起面板，避免正在打开的面板跟着入口一起消失。
                if (servers.length === 1) setOpen(false);
                void dismiss(server.id);
              }}
            >
              <svg {...iconProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </span>
      </li>
    );
  };

  return (
    <div ref={rootRef} className="dev-servers-shelf">
      {open && (
        <div className="extension-widget-panels dev-servers-panels">
          <section id={panelId} className="extension-widget-panel dev-servers-panel" aria-label={t("servers.title")}>
            <div className="extension-widget-panel-heading">{t("servers.title")}</div>
            {servers.length > 0 && <ul className="dev-server-list">{servers.map(renderServer)}</ul>}
            {declared.length > 0 && (
              <>
                <div className="dev-server-subheading">{t("servers.declared")}</div>
                <ul className="dev-server-list">
                  {declared.map((config) => (
                    <li key={config.name} className="dev-server-row is-declared">
                      <span className="dev-server-dot" aria-hidden="true" />
                      <span className="dev-server-name" title={config.source}>{config.name}</span>
                      <span className="dev-server-meta">{hostLabel(config.url)}</span>
                      <span className="dev-server-actions">
                        <button
                          type="button"
                          className="dev-server-action"
                          disabled={pending.has(`start:${config.name}`)}
                          title={t("servers.start")}
                          aria-label={`${t("servers.start")} ${config.name}`}
                          onClick={() => void start(config.name)}
                        >
                          <svg {...iconProps}><path d="M7 5l12 7-12 7z" /></svg>
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {data.errors.length > 0 && (
              <div className="dev-server-errors" role="note">
                <div className="dev-server-subheading">{t("servers.launchErrors")}</div>
                {data.errors.map((item) => <div key={item}>{item}</div>)}
              </div>
            )}
            {error && <p role="alert" className="dev-server-error">{error}</p>}
          </section>
        </div>
      )}
      <button
        type="button"
        className={`extension-widget-trigger dev-servers-trigger${open ? " is-expanded" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="extension-widget-placement" aria-hidden="true">^</span>
        <span className="extension-widget-key">{t("servers.trigger")}</span>
        {runningCount > 0 && <span className="dev-servers-count">{runningCount}</span>}
        {hasErrors && <span className="dev-servers-error-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
