"use client";

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { FilePlus2 } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import {
  getSystemPromptAddon,
  isSystemPromptAddonStaged,
  putSystemPromptAddon,
  setSystemPromptAddonStaged,
  type SystemPromptAddonState,
} from "@/lib/system-prompt-addon-client";

/** 顶栏点击收起“更多”菜单时据此放行：编辑框 portal 在工具栏 DOM 之外。 */
export const SYSTEM_PROMPT_ADDON_EDITOR_ATTR = "data-system-prompt-addon-editor";

const POPOVER_WIDTH = 480;
const VIEWPORT_GUTTER = 16;

const actionButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "none",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
};

export const SystemPromptAddonToggle = memo(function SystemPromptAddonToggle({
  scopeKey,
  sessionId,
  onChange,
  compact = false,
}: {
  /** 会话 id 或 `new:<cwd>`；null 表示当前没有可操作的会话。 */
  scopeKey: string | null;
  sessionId: string | null;
  /** 当前会话的开关或内容已保存，实际系统提示词随之变化。 */
  onChange?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [addon, setAddon] = useState<SystemPromptAddonState | null>(null);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<{ top: number; left: number; width: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const enableOnSaveRef = useRef(false);

  const stagedCwd = !sessionId && scopeKey?.startsWith("new:") ? scopeKey.slice("new:".length) : null;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  const loadForScope = useCallback(async (): Promise<SystemPromptAddonState> => {
    const latest = await getSystemPromptAddon(sessionId);
    return stagedCwd === null ? latest : { ...latest, enabled: isSystemPromptAddonStaged(stagedCwd) };
  }, [sessionId, stagedCwd]);

  useEffect(() => {
    let cancelled = false;
    setAddon(null);
    setEditor(null);
    if (scopeKey === null) return;
    loadForScope().then((value) => { if (!cancelled) setAddon(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loadForScope, scopeKey]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (stagedCwd !== null) {
      setSystemPromptAddonStaged(stagedCwd, enabled);
      return { enabled };
    }
    if (!sessionId) throw new Error("No active session");
    return putSystemPromptAddon({ sessionId, enabled });
  }, [sessionId, stagedCwd]);

  const openEditor = useCallback(async (enableOnSave: boolean) => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const left = Math.max(VIEWPORT_GUTTER, Math.min(rect.left, window.innerWidth - width - VIEWPORT_GUTTER));
    enableOnSaveRef.current = enableOnSave;
    setError(null);
    setEditor({ top: rect.bottom + 4, left, width });
    // 打开时取最新值，其他页面可能刚保存过。
    try {
      const latest = await loadForScope();
      setAddon(latest);
      setDraft(latest.text);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [loadForScope]);

  const dirty = editor !== null && addon !== null && draft !== addon.text;
  const closeEditor = useCallback(() => setEditor(null), []);

  useEffect(() => {
    if (!editor || dirty) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!event.composedPath().includes(popoverRef.current as EventTarget)) closeEditor();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeEditor, dirty, editor]);

  const hasText = Boolean(addon?.text.trim());
  const effective = Boolean(addon?.enabled) && hasText;

  const toggle = useCallback(async () => {
    if (!addon || pending) return;
    if (!hasText) {
      void openEditor(true);
      return;
    }
    const scope = scopeRef.current;
    setPending(true);
    try {
      const { enabled } = await setEnabled(!effective);
      if (scopeRef.current === scope) setAddon((previous) => previous && { ...previous, enabled });
      if (sessionId) onChange?.();
    } catch (toggleError) {
      if (scopeRef.current === scope) {
        await openEditor(false);
        setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
      }
    } finally {
      setPending(false);
    }
  }, [addon, effective, hasText, onChange, openEditor, pending, sessionId, setEnabled]);

  const save = useCallback(async () => {
    if (pending) return;
    const scope = scopeRef.current;
    setPending(true);
    setError(null);
    try {
      // 清空后没有可注入的内容，开关回到关闭；文本为空时点开关打开的编辑框，保存即开启。
      const nextEnabled = !draft.trim() ? false : enableOnSaveRef.current ? true : null;
      // 会话里只写自己的快照；新会话页写的是之后新会话的默认内容。
      const { text } = await putSystemPromptAddon({
        text: draft,
        ...(sessionId ? { sessionId, ...(nextEnabled === null ? {} : { enabled: nextEnabled }) } : {}),
      });
      if (!sessionId && nextEnabled !== null) await setEnabled(nextEnabled);
      if (scopeRef.current === scope) {
        setAddon((previous) => previous && { text, enabled: nextEnabled ?? previous.enabled });
        setEditor(null);
      }
      if (sessionId) onChange?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  }, [draft, onChange, pending, sessionId, setEnabled]);

  const enabled = effective;
  const switchTitle = enabled ? t("systemPromptAddon.disable") : t("systemPromptAddon.enable");

  return (
    <div ref={anchorRef} style={{ display: "flex", alignItems: "center", height: "100%", borderRight: "1px solid var(--border)", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => { if (editor) closeEditor(); else void openEditor(false); }}
        title={t("systemPromptAddon.edit")}
        aria-label={t("systemPromptAddon.edit")}
        aria-expanded={editor !== null}
        disabled={!addon}
        style={{ display: "flex", alignItems: "center", gap: 7, height: "100%", padding: compact ? "0 4px 0 9px" : "0 6px 0 12px", border: "none", background: "none", color: enabled ? "var(--text-muted)" : "var(--text-dim)", cursor: addon ? "pointer" : "not-allowed", fontSize: 11, whiteSpace: "nowrap" }}
      >
        <FilePlus2 size={13} aria-hidden="true" style={{ color: enabled ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} />
        {!compact && <span>{t("systemPromptAddon.label")}</span>}
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => void toggle()}
        disabled={!addon || pending}
        title={switchTitle}
        aria-label={switchTitle}
        style={{ display: "flex", alignItems: "center", height: "100%", padding: compact ? "0 9px 0 4px" : "0 12px 0 6px", border: "none", background: "none", cursor: addon && !pending ? "pointer" : "not-allowed" }}
      >
        <span aria-hidden="true" style={{ position: "relative", width: 24, height: 14, borderRadius: 999, background: enabled ? "var(--accent)" : "var(--border)", opacity: pending ? 0.55 : 1, transition: "background 0.15s, opacity 0.15s" }}>
          <span style={{ position: "absolute", top: 2, left: enabled ? 12 : 2, width: 10, height: 10, borderRadius: "50%", background: "var(--bg-panel)", boxShadow: "0 1px 2px rgba(0,0,0,0.22)", transition: "left 0.15s" }} />
        </span>
      </button>
      {editor && createPortal(
        <div
          ref={popoverRef}
          {...{ [SYSTEM_PROMPT_ADDON_EDITOR_ATTR]: "true" }}
          role="dialog"
          aria-label={t("systemPromptAddon.title")}
          style={{ position: "fixed", top: editor.top, left: editor.left, width: editor.width, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)", boxShadow: "0 12px 32px rgba(0,0,0,0.18)" }}
        >
          <div style={{ fontSize: 12, color: "var(--text)" }}>{t("systemPromptAddon.title")}</div>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>{t(sessionId ? "systemPromptAddon.hint" : "systemPromptAddon.hintDefault")}</div>
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("systemPromptAddon.placeholder")}
            rows={10}
            style={{ width: "100%", maxHeight: "50vh", resize: "vertical", padding: 8, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box" }}
          />
          {error && <div role="alert" style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={closeEditor} style={actionButtonStyle}>{t("systemPromptAddon.cancel")}</button>
            <button type="button" onClick={() => void save()} disabled={pending || !addon} style={{ ...actionButtonStyle, borderColor: "var(--accent)", background: "var(--accent)", color: "#fff" }}>{t("systemPromptAddon.save")}</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});
