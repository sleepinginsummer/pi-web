"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Activity, ChevronUp } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { browserServerUrl, isDevServerActive, useDevServers } from "@/hooks/useDevServers";
import { isScheduledTaskPending, useScheduledTasks } from "@/hooks/useScheduledTasks";
import { useBackgroundCommandOutput, useBackgroundCommands } from "@/hooks/useBackgroundCommands";
import type { BackgroundCommandSnapshot, DevServerSnapshot, ScheduledTask } from "@/lib/types";

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

function shortTime(ms: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
/** 时间同时保留完整日期，避免跨天任务只显示时分造成歧义。 */
function TaskTime({ value, label }: { value: number; label: string }) {
  const date = new Date(value);
  return <time className="scheduled-task-owner" dateTime={date.toISOString()} title={date.toLocaleString()}>{label} {date.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>;
}

function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The current time, ticking every second while `enabled`. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function BackgroundCommandRow({
  command,
  busy,
  onStop,
  onDismiss,
}: {
  command: BackgroundCommandSnapshot;
  busy: boolean;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const active = command.status === "running" || command.status === "stopping";
  const lines = useBackgroundCommandOutput(expanded ? command.id : null, active);
  const now = useNow(active);
  const time = elapsed(command.startedAt, command.endedAt ?? Math.max(now, command.startedAt));
  const state = command.status === "running"
    ? t("bg.running", { time })
    : command.status === "stopping"
      ? t("bg.stopping")
      : command.status === "stopped"
        ? t("bg.stopped")
        : command.status === "interrupted"
          ? t("bg.interrupted")
        : command.status === "exited"
          ? t("bg.exited", { time })
          : command.error
            ? t("bg.failedToRun")
            : t("bg.failed", { code: String(command.exitCode ?? "?"), time });
  const dot = command.status === "exited" || command.status === "stopped" ? "stopped" : command.status === "interrupted" ? "failed" : command.status;
  return (
    <li className="background-command-item">
      <div className={`dev-server-row scheduled-task-row is-${dot}`}>
        <span className="dev-server-dot" aria-hidden="true" />
        <span className="dev-server-name" title={command.command}>
          {command.label ?? command.command}
          <TaskTime value={command.startedAt} label={t("tasks.startedAt")} />
          {command.notifyError && <span className="scheduled-task-owner is-error">{t("bg.notifyFailed", { error: command.notifyError })}</span>}
        </span>
        <span className="dev-server-meta">{state}</span>
        <span className="dev-server-actions">
          <button
            type="button"
            className={`dev-server-action${expanded ? " is-active" : ""}`}
            aria-expanded={expanded}
            title={t("bg.output")}
            aria-label={`${t("bg.output")} ${command.label ?? command.command}`}
            onClick={() => setExpanded((value) => !value)}
          >
            <svg {...iconProps}><path d="M4 6h16M4 12h16M4 18h10" /></svg>
          </button>
          {active ? (
            <button
              type="button"
              className="dev-server-action is-danger"
              disabled={busy || command.status === "stopping"}
              title={t("bg.stop")}
              aria-label={`${t("bg.stop")} ${command.label ?? command.command}`}
              onClick={onStop}
            >
              <svg {...iconProps}><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            </button>
          ) : (
            <button
              type="button"
              className="dev-server-action"
              disabled={busy}
              title={t("bg.dismiss")}
              aria-label={`${t("bg.dismiss")} ${command.label ?? command.command}`}
              onClick={onDismiss}
            >
              <svg {...iconProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <pre className="background-command-output">
          {`$ ${command.command}\n`}
          {lines === null ? "…" : lines.length ? lines.join("\n") : t("bg.noOutput")}
        </pre>
      )}
    </li>
  );
}

/**
 * The bottom bar's dev server, scheduled task and background command entry: a trigger like an
 * extension widget's, opening the project's lists. Shown once the project has
 * a server this pi-web process started (running or finished), a launch file
 * that failed to parse, a scheduled task or a background command; declared
 * servers that never ran are listed inside it but do not make it appear.
 */
export function DevServersShelf({
  cwd,
  sessionId,
  onOpenPreview,
  isMobile = false,
}: {
  cwd: string | null | undefined;
  sessionId?: string | null;
  isMobile?: boolean;
  onOpenPreview?: (serverId: string, label: string) => void;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { data, error, pending, start, stop, dismiss } = useDevServers(cwd);
  const scheduled = useScheduledTasks(cwd);
  const background = useBackgroundCommands(cwd);

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

  if (!data && !scheduled.data && !background.data) return null;
  const servers = data?.servers ?? [];
  const launchErrors = data?.errors ?? [];
  const activeNames = new Set(servers.filter(isDevServerActive).map((server) => server.name));
  const declared = data?.enabled ? data.configs.filter((config) => !activeNames.has(config.name)) : [];
  // 只显示当前会话自己的定时任务与后台命令；其他会话的记录不进这个入口。
  const tasks = (scheduled.data?.tasks ?? []).filter((task) => task.sessionId === sessionId);
  const commands = (background.data?.commands ?? []).filter((command) => command.sessionId === sessionId);
  const showServers = servers.length > 0 || launchErrors.length > 0;
  if (!showServers && tasks.length === 0 && commands.length === 0) return null;
  const runningCommandCount = commands.filter((command) => command.status === "running" || command.status === "stopping").length;
  // 已结束的（一次性任务触发完、命令已退出/停止）收进折叠区，不占面板正文。
  const finishedTasks = tasks.filter((task) => task.nextRunAt === null);
  const openTasks = tasks.filter((task) => task.nextRunAt !== null);
  const finishedCommands = commands.filter((command) => command.status !== "running" && command.status !== "stopping");
  const openCommands = commands.filter((command) => command.status === "running" || command.status === "stopping");
  const finishedCount = finishedTasks.length + finishedCommands.length;

  const runningCount = servers.filter(isDevServerActive).length;
  const pendingTaskCount = scheduled.data?.enabled ? tasks.filter(isScheduledTaskPending).length : 0;
  // 启动配置有问题时入口带告警红点，读屏用带错误的文案，不占用运行计数。
  const hasErrors = launchErrors.length > 0 || tasks.some((task) => task.lastStatus === "error" && isScheduledTaskPending(task));
  const serverLabel = launchErrors.length > 0
    ? t("servers.triggerErrors")
    : runningCount > 0
      ? t("servers.triggerLabel", { count: runningCount })
      : t("servers.title");
  const label = [
    showServers ? serverLabel : "",
    tasks.length > 0 ? t("tasks.triggerLabel", { count: pendingTaskCount }) : "",
    commands.length > 0 ? t("bg.triggerLabel", { count: runningCommandCount }) : "",
  ].filter(Boolean).join("; ");
  // 定时任务和后台命令共用「任务」一个词，具体数量交给图标徽标。
  const hasTaskEntries = tasks.length > 0 || commands.length > 0;
  const triggerText = [
    showServers ? t("servers.trigger") : "",
    hasTaskEntries ? t("tasks.triggerShort") : "",
  ].filter(Boolean).join(" · ");

  const renderTask = (task: ScheduledTask) => {
    const live = isScheduledTaskPending(task);
    const status = task.lastStatus === "error" && live ? "failed" : live ? (scheduled.data?.enabled ? "running" : "stopped") : "stopped";
    const busy = scheduled.pending.has(task.id);
    const schedule = (task.schedule.kind === "cron" ? task.schedule.expression : t("tasks.once"))
      + (task.delivery === "steer" ? ` · ${t("tasks.steer")}` : "");
    const state = task.nextRunAt === null
      ? t("tasks.finished")
      : !task.enabled
        ? t("tasks.paused")
        : t("tasks.next", { time: shortTime(task.nextRunAt) });
    // 列表里只剩当前会话的任务，归属会话既不用标注也不用链接。
    const title = [
      task.prompt,
      task.lastStatus === "error" && task.lastError ? t("tasks.lastFailed", { error: task.lastError }) : "",
    ].filter(Boolean).join("\n\n");
    return (
      <li key={task.id} className={`dev-server-row scheduled-task-row is-${status}`}>
        <span className="dev-server-dot" aria-hidden="true" />
        <span className="dev-server-name" title={title}>
          {task.name}
          <TaskTime value={task.createdAt} label={t("tasks.createdAt")} />
        </span>
        <span className="dev-server-meta" title={task.lastError}>{schedule} · {state}</span>
        <span className="dev-server-actions">
          <button
            type="button"
            className="dev-server-action"
            disabled={busy || !scheduled.data?.enabled}
            title={t("tasks.runNow")}
            aria-label={`${t("tasks.runNow")} ${task.name}`}
            onClick={() => void scheduled.act(task.id, "run")}
          >
            <svg {...iconProps}><path d="M7 5l12 7-12 7z" /></svg>
          </button>
          {task.nextRunAt !== null && (
            <button
              type="button"
              className="dev-server-action"
              disabled={busy}
              title={task.enabled ? t("tasks.pause") : t("tasks.resume")}
              aria-label={`${task.enabled ? t("tasks.pause") : t("tasks.resume")} ${task.name}`}
              onClick={() => void scheduled.act(task.id, task.enabled ? "pause" : "resume")}
            >
              {task.enabled
                ? <svg {...iconProps}><path d="M9 5v14M15 5v14" /></svg>
                : <svg {...iconProps}><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>}
            </button>
          )}
          <button
            type="button"
            className="dev-server-action is-danger"
            disabled={busy}
            title={t("tasks.delete")}
            aria-label={`${t("tasks.delete")} ${task.name}`}
            onClick={() => {
              if (tasks.length === 1 && !showServers && commands.length === 0) setOpen(false);
              void scheduled.act(task.id, "delete");
            }}
          >
            <svg {...iconProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </span>
      </li>
    );
  };

  const renderCommand = (command: BackgroundCommandSnapshot) => (
    <BackgroundCommandRow
      key={command.id}
      command={command}
      busy={background.pending.has(command.id)}
      onStop={() => void background.act(command.id, "stop")}
      onDismiss={() => {
        if (commands.length === 1 && !showServers && tasks.length === 0) setOpen(false);
        void background.act(command.id, "dismiss");
      }}
    />
  );
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
        <div className="extension-widget-panels extension-widget-panels-left">
          <section id={panelId} className="extension-widget-panel dev-servers-panel" aria-label={label}>
            {showServers && <>
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
            {launchErrors.length > 0 && (
              <div className="dev-server-errors" role="note">
                <div className="dev-server-subheading">{t("servers.launchErrors")}</div>
                {launchErrors.map((item) => <div key={item}>{item}</div>)}
              </div>
            )}
            {error && <p role="alert" className="dev-server-error">{error}</p>}
            </>}
            {openTasks.length > 0 && <>
              <div className={`extension-widget-panel-heading${showServers ? " scheduled-tasks-heading" : ""}`}>{t("tasks.title")}</div>
              <ul className="dev-server-list">{openTasks.map(renderTask)}</ul>
              {scheduled.error && <p role="alert" className="dev-server-error">{scheduled.error}</p>}
            </>}
            {openCommands.length > 0 && <>
              <div className={`extension-widget-panel-heading${showServers || openTasks.length > 0 ? " scheduled-tasks-heading" : ""}`}>{t("bg.title")}</div>
              <ul className="dev-server-list">
                {openCommands.map(renderCommand)}
              </ul>
              {background.error && <p role="alert" className="dev-server-error">{background.error}</p>}
            </>}
            {finishedCount > 0 && (
              <details className="finished-tasks">
                <summary className={`extension-widget-panel-heading${showServers || openTasks.length > 0 || openCommands.length > 0 ? " scheduled-tasks-heading" : ""}`}>
                  {t("tasks.finishedSection", { count: finishedCount })}
                </summary>
                {finishedTasks.length > 0 && <>
                  <div className="dev-server-subheading">{t("tasks.title")}</div>
                  <ul className="dev-server-list">{finishedTasks.map(renderTask)}</ul>
                </>}
                {finishedCommands.length > 0 && <>
                  <div className="dev-server-subheading">{t("bg.title")}</div>
                  <ul className="dev-server-list">{finishedCommands.map(renderCommand)}</ul>
                </>}
              </details>
            )}
          </section>
        </div>
      )}
      <button
        type="button"
        className={`extension-widget-trigger dev-servers-trigger${open ? " is-expanded" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={isMobile ? `${t("servers.activity")} · ${label}` : label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="extension-widget-placement" aria-hidden="true"><ChevronUp size={12} className="extension-widget-chevron" /></span>
        <span className="extension-widget-key">{triggerText}</span>
        <span className="mobile-activity-label" aria-hidden="true"><Activity size={15} />{t("servers.activity")}<ChevronUp className="mobile-activity-chevron" size={12} /></span>
        {runningCount > 0 && <span className="dev-servers-count">{runningCount}</span>}
        {/* 两类各一个图标+数量，只有一类就不出现另一个（桌面和手机同一套）。 */}
        {tasks.length > 0 && (
          <span className="dev-servers-count scheduled-tasks-count" aria-hidden="true">
            <svg {...iconProps} width={9} height={9}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            {tasks.length}
          </span>
        )}
        {commands.length > 0 && (
          <span className="dev-servers-count scheduled-tasks-count" aria-hidden="true">
            <svg {...iconProps} width={9} height={9}><path d="M5 7l5 5-5 5M12 17h7" /></svg>
            {commands.length}
          </span>
        )}
        {hasErrors && <span className="dev-servers-error-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
