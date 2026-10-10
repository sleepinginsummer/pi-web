"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import { createTerminalWriter, terminalRequest } from "@/lib/terminal-client";
import { requestDirectStreamSlots } from "@/lib/sse-broker-client";
import type { TerminalEvent } from "@/lib/terminal-manager";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
}

export function TerminalPanel({ tab, active, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  /** 关闭流程要在另一个 effect 里先取消在途的额度申请（它是本 effect 的局部状态）。 */
  const cancelSlotWaitRef = useRef<() => void>(() => {});
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let events: EventSource | null = null;
    // 真正建立连接的动作；只有拿到额度后才执行。
    const openStream = () => {
      // ptyStarted 未真时不能建 SSE：服务端还没有进程，连接只会 404。
      // startupAborted：面板已关闭（可能还没卸载），迟到的恢复事件不得再建连。
      if (disposed || exited || startupAborted || !navigator.onLine || streaming || !ptyStarted) return;
      streaming = true;
      events?.close();
      // 终端刻意不接入共享上游：服务端的历史重放是按连接做的，而共享连接只对第一个
      // 订阅者重放；同时"暂停"会断开监听，PTY 会被回收。因此终端保持自己的一条连接，
      // 但这条连接同样吃同源额度，必须先通过 requestDirectStreamSlots 拿到许可。
      events = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`);
      events.onmessage = (message: MessageEvent) => {
        const event = JSON.parse(message.data) as TerminalEvent;
        if (event.type === "output") {
          if (event.reset) terminal.reset();
          else if (offset !== undefined && event.offset <= offset) return;
          terminal.write(event.data);
          offset = event.offset;
        } else {
          exited = true;
          connected = false;
          streaming = false;
          terminal.options.disableStdin = true;
          events?.close();
          // 进程已退出：立刻归还额度，保留着的标签页不该继续压低 broker 上限。
          releaseTerminalSlot();
          setExitCode(event.type === "exit" ? event.exitCode : null);
          setStatus("exited");
        }
      };
      events.onopen = () => {
        connected = true;
        if (inputFailed) return;
        terminal.options.disableStdin = false;
        setStatus("ready");
        fitAndResize();
        writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
      };
      events.onerror = () => {
        if (disposed || exited) return;
        connected = false;
        streaming = false;
        terminal.options.disableStdin = true;
        setStatus(events?.readyState === EventSource.CLOSED ? "error" : "connecting");
      };
    };

    /**
     * 终端占一条同源长连接额度：必须先拿到许可才建连（额度不足时等补授），
     * 连接结束或面板卸载时立刻归还，保留的标签页不会继续压低 broker 上限。
     */
    // 关闭终止标志：必须早于任何回调声明，授予回调可能在同步路径里就读到它。
    let startupAborted = false;
    let lease: { release: () => void } | null = null;
    let granted = 0;
    let streaming = false;
    let ptyStarted = false;
    // 单个等待者 + 明确取消：丢弃 promise 回调会让启动流程永远卡住。
    let slotWaiter: { settle: (grantedNow: boolean) => void } | null = null;
    const settleSlotWait = (grantedNow: boolean) => {
      const waiter = slotWaiter;
      slotWaiter = null;
      waiter?.settle(grantedNow);
    };
    const applyGrant = (slots: number) => {
      if (startupAborted) return;
      granted = slots;
      if (granted >= 1) {
        settleSlotWait(true);
        if (ptyStarted && !streaming) openStream();
        return;
      }
      // 许可被收回（例如后台恢复后重授为 0）：必须关掉已有连接，不能绕过预算继续收。
      if (streaming) {
        streaming = false;
        events?.close();
        events = null;
        connected = false;
        terminal.options.disableStdin = true;
        if (!exited && !inputFailed) setStatus("connecting");
      }
    };
    const acquireTerminalSlot = () => {
      if (lease) return;
      lease = { release: requestDirectStreamSlots(1, applyGrant) };
    };
    /**
     * 等到真正拿到额度（创建 PTY 之前必须先满足它）。
     * 返回 false 表示这次等待被取消（离线/后台/关闭），调用方据此决定重试还是收尾。
     */
    const waitForTerminalSlot = () => new Promise<boolean>((resolve) => {
      if (granted >= 1) {
        resolve(true);
        return;
      }
      slotWaiter = { settle: resolve };
      acquireTerminalSlot();
    });
    const releaseTerminalSlot = () => {
      lease?.release();
      lease = null;
      granted = 0;
    };
    /** 页面离开/离线：本窗口的租约已被 worker 回收，本地许可作废并取消在途等待。 */
    const invalidateTerminalSlot = () => {
      releaseTerminalSlot();
      settleSlotWait(false);
    };
    // 恢复等待也必须可结束：关闭时若正停在这一步，await startRef.current 会挂住。
    let cancelResumeWait: (() => void) | null = null;
    const waitForResume = () => new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("online", done);
        window.removeEventListener("pageshow", done);
        cancelResumeWait = null;
        resolve();
      };
      cancelResumeWait = done;
      window.addEventListener("online", done, { once: true });
      window.addEventListener("pageshow", done, { once: true });
    });
    /**
     * 关闭面板：终止启动流程（不是暂停）。终止后额度回执与恢复事件都不再创建进程，
     * 且在途的额度等待与恢复等待都要立刻结束，否则关闭会被挂住。
     */
    cancelSlotWaitRef.current = () => {
      // 关闭顺序不能反：先断开实际连接、清理本地状态，再归还额度。
      // 反过来会让 broker 提前把额度给别人，而这条 SSE 还开着——连接数被低估。
      startupAborted = true;
      streaming = false;
      connected = false;
      events?.close();
      events = null;
      terminal.options.disableStdin = true;
      settleSlotWait(false);
      cancelResumeWait?.();
      releaseTerminalSlot();
    };
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      disableStdin: true,
      theme: {
        background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
        selectionBackground: "#365b8a",
        black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
        brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9", brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const writer = createTerminalWriter(id, (reason) => {
      if (disposed) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    });
    writerRef.current = writer;
    const onData = terminal.onData((data) => {
      if (connected && !exited && !inputFailed) writer.write(data);
    });
    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    const onResize = terminal.onResize(({ cols, rows }) => {
      if (connected && !exited && !inputFailed) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const connect = () => {
      if (disposed || exited || startupAborted || !navigator.onLine) return;
      streaming = false;
      // 先取额度：拿不到就保持等待（授予回调里再建连），不能先连上再补账。
      if (granted >= 1) openStream();
      else void waitForTerminalSlot();
    };

    startRef.current = (async () => {
      fitAndResize();
      // 服务端在 PTY 创建时就开始计"无监听回收"（120s）：额度排队太久会让进程被回收，
      // 之后建 SSE 只会 404。因此先拿到额度再创建进程。
      while (!disposed && !exited && !startupAborted) {
        if (granted >= 1) break;
        const grantedNow = await waitForTerminalSlot();
        if (disposed || exited || startupAborted) return;
        if (grantedNow) break;
        // 等待被取消（离线/后台）：等下一次恢复事件再继续；关闭已由 startupAborted 排除。
        await waitForResume();
      }
      // 关闭/卸载后绝不再创建进程。
      if (disposed || exited || startupAborted) return;
      if (restored || reconnectKey > 0) {
        // Restoring a tab must never silently launch a replacement shell.
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
        });
      }
      if (disposed || exited || startupAborted) return;
      ptyStarted = true;
      connect();
    })().catch((reason: Error) => {
      if (disposed) return;
      // 创建失败/已取消：立刻归还额度，别让它占着 broker 上限。
      releaseTerminalSlot();
      setError(reason.message);
      setStatus("error");
    });

    const pageHide = () => {
      connected = false;
      streaming = false;
      terminal.options.disableStdin = true;
      events?.close();
      events = null;
      // worker 已回收本窗口租约：本地许可一并作废，恢复后必须等重新授予，
      // 否则会先建连再等许可，期间可能已经超过同源连接预算。
      invalidateTerminalSlot();
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      releaseTerminalSlot();
      events?.close();
      void writer.stop();
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, restored, reconnectKey]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!tab.closing) return;
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      // 先取消在途的额度申请/启动等待，否则"拿不到额度"会让关闭一直挂着。
      cancelSlotWaitRef.current();
      await startRef.current;
      await writerRef.current?.stop();
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className="terminal-panel" aria-label={t("terminal.title")}>
      <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
    </section>
  );
}
