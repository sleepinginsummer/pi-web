"use client";

import { Archive, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "@/lib/image-attachments";
import type { StashedContent, StashedMessage, StashSnapshot } from "@/lib/message-stash-protocol";

type SendMode = "send" | "steer" | "followUp";
type Selection = { item: StashedMessage } & (
  | { kind: "edit" | "preview"; draft: StashedContent }
  | { kind: "schedule"; time: string }
  | { kind: "send" | "delete" | "recover" }
);

interface Props {
  cwd: string;
  mobile: boolean;
  hasDraft: boolean;
  session?: { id: string; label: string };
  sendMode: "idle" | "running" | "unavailable";
  onSaveDraft: (save: (draft: StashedContent) => Promise<unknown>) => Promise<void>;
  onSendDraft: (draft: StashedContent, mode: SendMode) => Promise<boolean>;
}

function localTime(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function readImage(file: File) {
  if (!file.type.startsWith("image/") || file.size > MAX_ATTACHED_IMAGE_BYTES) throw new Error("Invalid image attachment");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { data, mimeType: file.type };
}

async function request<T>(cwd: string, action: string, parameters: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/message-stash", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, action, ...parameters }), signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function MessageStash({ cwd, mobile, hasDraft, session, sendMode, onSaveDraft, onSendDraft }: Props) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const refreshVersion = useRef(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<StashSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++refreshVersion.current;
    const result = await request<StashSnapshot>(cwd, "list", {}, signal);
    if (!signal?.aborted && version === refreshVersion.current) setSnapshot(result);
  }, [cwd]);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    function position() {
      const box = trigger.current?.getBoundingClientRect();
      if (box) {
        element.style.setProperty("--stash-right", `${Math.max(8, innerWidth - box.right)}px`);
        element.style.setProperty("--stash-bottom", `${Math.max(8, innerHeight - box.top + 6)}px`);
      }
    }
    position();
    element.showModal();
    window.addEventListener("resize", position);
    const controller = new AbortController();
    const update = () => {
      if (!pending.current && !document.hidden) void refresh(controller.signal).catch(() => {
        if (!controller.signal.aborted) setError(t("stash.loadFailed"));
      });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("resize", position);
      element.close();
    };
  }, [open, refresh, t]);

  function close() {
    setOpen(false);
    setSelection(null);
  }

  async function perform(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("stash.failed"));
    } finally {
      try { await refresh(); } catch { setError((previous) => previous || t("stash.loadFailed")); }
      pending.current = false;
      setBusy(false);
    }
  }

  function choose(item: StashedMessage, kind: "edit" | "preview") {
    void perform(async () => {
      const draft = await request<StashedContent>(cwd, "load", item);
      setSelection({ item, kind, draft });
    });
  }

  function change(item: StashedMessage, action: string, extra: object = {}) {
    void perform(async () => {
      await request(cwd, action, { id: item.id, revision: item.revision, ...extra });
      setSelection(null);
    });
  }

  function send(item: StashedMessage, mode: SendMode) {
    void perform(async () => {
      const { token, draft } = await request<{ token: string; draft: StashedContent }>(cwd, "claim", item);
      // 释放弹窗的焦点锁，发送可能触发扩展审批或会话切换。
      dialog.current?.close();
      close();
      let sent: boolean;
      try {
        sent = await onSendDraft(draft, mode);
        await request(cwd, "finish", { id: item.id, token, sent });
      } catch (error) {
        // 确认丢失时保留认领，避免自动再发一遍。
        setOpen(true);
        throw new Error(t("stash.sendUnconfirmed"), { cause: error });
      }
      if (!sent) {
        setOpen(true);
        throw new Error(t("stash.sendFailed"));
      }
    });
  }

  async function addImages(current: Extract<Selection, { kind: "edit" | "preview" }>, files: File[]) {
    if (!files.length) return;
    if (current.draft.images.length + files.length > MAX_ATTACHED_IMAGES) throw new Error(t("stash.imageLimit", { count: MAX_ATTACHED_IMAGES }));
    const added = await Promise.all(files.map(readImage));
    setSelection((latest) => latest === current ? { ...current, draft: { ...current.draft, images: [...current.draft.images, ...added] } } : latest);
  }

  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  return (
    <>
      <button ref={trigger} type="button" className="message-stash-trigger" title={t("stash.label")} aria-label={t("stash.label")}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); setError(""); setNotice(""); }}>
        <Archive size={16} aria-hidden="true" />
      </button>
      {open && <dialog ref={dialog} aria-labelledby={titleId} className={`message-stash-dialog${mobile ? " is-mobile" : ""}`}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }} onCancel={(event) => { event.preventDefault(); close(); }}>
        <div className="message-stash-panel">
          <header>
            <h2 id={titleId}>{t("stash.label")}</h2>
            <button type="button" className="stash-primary" disabled={busy || !hasDraft} onClick={() => void perform(async () => {
              await onSaveDraft((draft) => request(cwd, "create", draft));
              setNotice(t("stash.saved"));
            })}>{t("stash.saveDraft")}</button>
            <button type="button" className="stash-close" aria-label={t("i18n.close")} onClick={close}><X size={16} aria-hidden="true" /></button>
          </header>
          {error && <p className="stash-feedback stash-error" role="alert">{error}</p>}
          {notice && <p className="stash-feedback" role="status">{notice}</p>}
          <div className="message-stash-list">
            {!snapshot && !error && <p>{t("i18n.loading")}</p>}
            {snapshot?.items.length === 0 && <p>{t("stash.empty")}</p>}
            {snapshot?.items.map((item) => {
              const active = selection?.item.id === item.id ? selection : null;
              const locked = busy || item.status === "sending" || item.status === "uncertain";
              const stale = Boolean(active && active.item.revision !== item.revision);
              return <article key={item.id}>
                {active?.kind === "edit" ? (
                  <textarea aria-label={t("stash.edit")} value={active.draft.text} rows={3} disabled={busy} onChange={(event) => {
                    setSelection({ ...active, draft: { ...active.draft, text: event.target.value } });
                  }} />
                ) : <p className="stash-preview">{(active?.kind === "preview" ? active.draft.text : item.preview) || t("stash.imageOnly")}</p>}
                {(active?.kind === "edit" || active?.kind === "preview") && <div className="stash-images">
                  {active.draft.images.map((image, index) => <div key={index}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`data:${image.mimeType};base64,${image.data}`} alt={t("stash.image", { index: index + 1 })} />
                    {active.kind === "edit" && <button type="button" disabled={busy} aria-label={t("stash.removeImage", { index: index + 1 })} onClick={() => {
                      setSelection({ ...active, draft: { ...active.draft, images: active.draft.images.filter((_, i) => i !== index) } });
                    }}><X size={12} aria-hidden="true" /></button>}
                  </div>)}
                </div>}
                {active?.kind === "edit" ? <div className="stash-actions">
                  <label className="stash-file">{t("stash.addImages")}
                    <input type="file" accept="image/*" multiple disabled={busy} onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      void perform(() => addImages(active, files));
                    }} />
                  </label>
                  <button type="button" className="stash-primary" disabled={busy || stale || (!active.draft.text.trim() && !active.draft.images.length)}
                    onClick={() => change(active.item, "edit", active.draft)}>{t("stash.save")}</button>
                  <button type="button" onClick={() => setSelection(null)}>{t("i18n.cancel")}</button>
                </div> : <>
                  {item.schedule && <p className="stash-meta">{date.format(item.schedule.at)} · {item.schedule.label}</p>}
                  {item.status !== "ready" && <p className="stash-meta">{t(`stash.status.${item.status}`)}</p>}
                  <div className="stash-actions">
                    {item.imageCount > 0 && <button type="button" disabled={busy} onClick={() => active?.kind === "preview" ? setSelection(null) : choose(item, "preview")}>
                      {t("stash.images", { count: item.imageCount })}
                    </button>}
                    {!item.schedule && item.status !== "uncertain" && <button type="button" className="stash-primary" disabled={locked || sendMode === "unavailable"} onClick={() => sendMode === "running" ? setSelection({ item, kind: "send" }) : send(item, "send")}>
                      {sendMode === "running" ? t("stash.sendOptions") : t("chat.send")}
                    </button>}
                    {item.status !== "uncertain" && <button type="button" disabled={locked || !snapshot?.schedulingEnabled || (!item.schedule && !session)}
                      title={!session && !item.schedule ? t("stash.requiresSession") : undefined}
                      onClick={() => setSelection({ item, kind: "schedule", time: localTime(item.schedule?.at ?? Date.now() + 600_000) })}>
                      {item.schedule ? t("stash.reschedule") : t("stash.schedule")}
                    </button>}
                    {item.schedule && <button type="button" disabled={locked} onClick={() => change(item, "cancelSchedule")}>{t("stash.cancelSchedule")}</button>}
                    {item.status === "uncertain" ? <button type="button" disabled={busy} onClick={() => setSelection({ item, kind: "recover" })}>{t("stash.recover")}</button>
                      : <button type="button" disabled={locked} onClick={() => choose(item, "edit")}>{t("stash.edit")}</button>}
                    <button type="button" className="stash-danger" disabled={busy || item.status === "sending"} onClick={() => setSelection({ item, kind: "delete" })}>{t("stash.delete")}</button>
                  </div>
                </>}
                {stale && <p className="stash-meta">{t("stash.changed")}</p>}
                {active?.kind === "send" && <div className="stash-actions">
                  <button type="button" disabled={locked || stale || sendMode !== "running"} onClick={() => send(active.item, "steer")}>{t("chat.steer")}</button>
                  <button type="button" disabled={locked || stale || sendMode !== "running"} onClick={() => send(active.item, "followUp")}>{t("chat.followUp")}</button>
                  <button type="button" onClick={() => setSelection(null)}>{t("i18n.cancel")}</button>
                </div>}
                {active?.kind === "schedule" && (() => {
                  const target = active.item.schedule ?? (session && { sessionId: session.id, label: session.label });
                  const at = new Date(active.time).getTime();
                  return <div className="stash-schedule">
                    <label>{t("stash.sendAt")} <input type="datetime-local" value={active.time} onChange={(event) => setSelection({ ...active, time: event.target.value })} /></label>
                    {target && <p className="stash-meta">{t("stash.target", { session: target.label })}</p>}
                    <div className="stash-actions">
                      <button type="button" className="stash-primary" disabled={locked || stale || !target || !(at > Date.now())}
                        onClick={() => target && change(active.item, "schedule", { at, sessionId: target.sessionId, label: target.label })}>{t("stash.confirmSchedule")}</button>
                      <button type="button" onClick={() => setSelection(null)}>{t("i18n.cancel")}</button>
                    </div>
                  </div>;
                })()}
                {(active?.kind === "delete" || active?.kind === "recover") && <div className="stash-actions">
                  <span>{t(active.kind === "delete" ? "stash.confirmDelete" : "stash.confirmRecover")}</span>
                  <button type="button" disabled={busy || stale} onClick={() => change(active.item, active.kind)}>{t("stash.confirm")}</button>
                  <button type="button" onClick={() => setSelection(null)}>{t("i18n.cancel")}</button>
                </div>}
              </article>;
            })}
          </div>
        </div>
      </dialog>}
    </>
  );
}
