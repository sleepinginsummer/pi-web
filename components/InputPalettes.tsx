"use client";

import React, { memo, useEffect, useLayoutEffect, useRef } from "react";
import { getSlashDescription, isDormantSkillCommand, SLASH_SOURCE_GROUP_LABEL_KEYS, type SlashCommandGroup, type SlashCommandPaletteItem } from "@/lib/slash-command-palette";
import type { AtQueryMatch, FileIndexEntry } from "@/lib/file-fuzzy";
import { useI18n } from "@/hooks/useI18n";
import { FolderIcon, getFileIcon } from "./FileIcons";

type DraftMaxHeightChange = (height: number | null) => void;
/** 所有输入补全浮层共用真实可见空间，软键盘、队列与多行草稿都可能抬高锚点。 */
function usePaletteHeight(open: boolean, content: unknown, onDraftMaxHeightChange?: DraftMaxHeightChange) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const palette = ref.current;
    const anchor = palette?.parentElement;
    const chat = palette?.closest<HTMLElement>(".chat-window");
    if (!open || !palette || !anchor || !chat) return;
    const viewport = window.visualViewport;
    const header = palette.firstElementChild;
    const body = palette.lastElementChild;
    const option = body?.querySelector("button");
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const top = Math.max(chat.getBoundingClientRect().top, viewport?.offsetTop ?? 0);
      const available = anchor.getBoundingClientRect().top - top - 8;
      const textarea = anchor.querySelector<HTMLTextAreaElement>(".chat-input-textarea");
      if (textarea && header && body && onDraftMaxHeightChange) {
        const padding = parseFloat(getComputedStyle(body).paddingBottom) || 0;
        // 加回 scrollTop，避免滚动列表时把第一条结果的屏幕位置误当成所需高度。
        const optionBottom = option
          ? option.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop
          : 40;
        const required = header.getBoundingClientRect().height + Math.max(40, optionBottom + padding) + 2;
        const style = getComputedStyle(textarea);
        const minimum = Math.max(parseFloat(style.minHeight) || 24, parseFloat(style.lineHeight) || 24);
        // available + 草稿高度不随本次收缩变化，不能按短缺量反复减，否则会形成尺寸反馈循环。
        onDraftMaxHeightChange(Math.max(minimum, Math.floor(available + textarea.getBoundingClientRect().height - required)));
      }
      palette.style.setProperty("--input-palette-height", `${Math.max(0, Math.floor(available))}px`);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    // 避免在 ResizeObserver 回调内同步改变被观察的输入框布局。
    const observer = new ResizeObserver(schedule);
    observer.observe(chat);
    observer.observe(anchor);
    if (header) observer.observe(header);
    if (option) observer.observe(option);
    const shell = palette.closest(".chat-input-shell");
    if (shell) observer.observe(shell);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      onDraftMaxHeightChange?.(null);
    };
  }, [open, content, onDraftMaxHeightChange]);
  return ref;
}

interface HistoryPaletteProps {
  open: boolean;
  items: string[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (text: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onDraftMaxHeightChange?: DraftMaxHeightChange;
}

export const HistoryPalette = memo(function HistoryPalette({
  open, items, activeIndex, onActiveIndexChange, onSelect, containerRef, onDraftMaxHeightChange,
}: HistoryPaletteProps) {
  const { t } = useI18n();
  const paletteRef = usePaletteHeight(open, items, onDraftMaxHeightChange);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current.length = items.length;
  }, [items.length]);
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, open]);

  if (!open || items.length === 0) return null;
  return (
    <div className="input-history-palette" ref={(node) => { paletteRef.current = node; containerRef.current = node; }} style={{ position: "absolute", left: 0, right: 0, bottom: "calc(100% + 8px)", zIndex: 120, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 -6px 20px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", overflow: "hidden", maxHeight: "min(44vh, 360px, var(--input-palette-height, 360px))" }}>
      <div title={t("chat.inputHistory")} style={{ flexShrink: 0, height: 30, padding: "0 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>
      </div>
      <div style={{ minHeight: 0, maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
        {items.map((item, index) => {
          const active = index === activeIndex;
          return <button key={`${index}:${item}`} ref={(node) => { itemRefs.current[index] = node; }} type="button"
            onMouseDown={(event) => { event.preventDefault(); onSelect(item); }} onMouseEnter={() => onActiveIndexChange(index)}
            style={{ width: "100%", display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 8px", border: "none", borderRadius: 6, background: active ? "var(--bg-selected)" : "none", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12.5, lineHeight: 1.45 }}>
            <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>{index + 1}</span>
            <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>{item}</span>
          </button>;
        })}
      </div>
    </div>
  );
});

interface SlashPaletteProps {
  open: boolean;
  loading?: boolean;
  matchCount: number;
  countLabel: string;
  groups: SlashCommandGroup[];
  activeIndex: number;
  skillDormancy: Record<string, boolean>;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: SlashCommandPaletteItem) => void;
  itemRefs: React.RefObject<Array<HTMLButtonElement | null>>;
  onDraftMaxHeightChange?: DraftMaxHeightChange;
}

export const SlashPalette = memo(function SlashPalette({
  open, loading, matchCount, countLabel, groups, activeIndex, skillDormancy, onActiveIndexChange, onSelect, itemRefs, onDraftMaxHeightChange,
}: SlashPaletteProps) {
  const { t } = useI18n();
  const paletteRef = usePaletteHeight(open, groups, onDraftMaxHeightChange);
  useEffect(() => {
    itemRefs.current.length = groups.reduce((count, group) => count + group.items.length, 0);
  }, [groups, itemRefs]);
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, itemRefs, open]);

  if (!open) return null;
  return (
    <div ref={paletteRef} className="slash-palette" style={{ position: "absolute", left: 0, right: 0, bottom: "calc(100% + 8px)", zIndex: 120, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 -6px 20px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", overflow: "hidden", maxHeight: "min(56vh, 460px, var(--input-palette-height, 460px))" }}>
      <div style={{ flexShrink: 0, padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
        <span>{loading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: countLabel })}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
      </div>
      <div style={{ minHeight: 0, maxHeight: "calc(min(56vh, 460px) - 34px)", overflowY: "auto", padding: 10 }}>
        {!loading && matchCount === 0 ? <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.noCommands")}</div> : groups.map((group) => (
          <section key={group.source} style={{ marginBottom: 12 }}>
            <div style={{ position: "sticky", top: -10, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 0 6px", background: "var(--bg)", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
              <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span><span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 8 }}>
              {group.items.map(({ command, index }) => {
                const active = index === activeIndex;
                const dormant = isDormantSkillCommand(command, skillDormancy);
                return <button key={`${command.source}:${command.name}`} ref={(node) => { itemRefs.current[index] = node; }} type="button"
                  onMouseDown={(event) => { event.preventDefault(); onSelect(command); }} onMouseEnter={() => onActiveIndexChange(index)}
                  style={{ width: "100%", minWidth: 0, minHeight: 58, display: "flex", flexDirection: "column", gap: 4, justifyContent: "center", padding: "9px 10px", border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`, borderRadius: 7, background: active ? "var(--bg-selected)" : "var(--bg-panel)", color: "var(--text)", cursor: "pointer", textAlign: "left", boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none" }}>
                  <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", wordBreak: "break-word", color: dormant ? "var(--text-dim)" : undefined }}>
                    /{command.name}{dormant && <span style={{ marginLeft: 6, padding: "0 4px", border: "1px solid var(--border)", borderRadius: 3, fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("chat.dormant")}</span>}
                  </span>
                  {command.description && <span style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", fontSize: 11, lineHeight: 1.35, color: "var(--text-dim)" }}>{getSlashDescription(command, t)}</span>}
                </button>;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
});

interface FileMentionPaletteProps {
  open: boolean;
  query: AtQueryMatch | null;
  cwd?: string | null;
  fileIndex: { cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null;
  indexLoading: boolean;
  matches: FileIndexEntry[];
  activeIndex: number;
  serverResultInUse: boolean;
  needsServerSearch: boolean;
  onActiveIndexChange: (index: number) => void;
  onSelect: (entry: FileIndexEntry) => void;
  onDraftMaxHeightChange?: DraftMaxHeightChange;
}

export const FileMentionPalette = memo(function FileMentionPalette({
  open, query, cwd, fileIndex, indexLoading, matches, activeIndex, serverResultInUse, needsServerSearch, onActiveIndexChange, onSelect, onDraftMaxHeightChange,
}: FileMentionPaletteProps) {
  const { t } = useI18n();
  const paletteRef = usePaletteHeight(open, matches, onDraftMaxHeightChange);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { itemRefs.current.length = matches.length; }, [matches.length]);
  useEffect(() => { if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activeIndex, open]);
  if (!open || query === null) return null;

  const loading = indexLoading && (!fileIndex || fileIndex.cwd !== cwd);
  const matchCountLabel = matches.length === 1 ? t("chat.match") : t("chat.matches", { count: matches.length });
  const truncatedHint = fileIndex?.truncated && !serverResultInUse ? (query.query ? t("chat.searchingAll") : t("chat.indexTruncated")) : "";
  return (
    <div className="file-mention-palette" ref={paletteRef} style={{ position: "absolute", left: 0, right: 0, bottom: "calc(100% + 8px)", zIndex: 120, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 -6px 20px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", overflow: "hidden", maxHeight: "min(48vh, 400px, var(--input-palette-height, 400px))" }}>
      <div style={{ flexShrink: 0, padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
        <span>{loading ? t("chat.loadingFiles") : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
      </div>
      <div style={{ minHeight: 0, maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
        {!loading && matches.length === 0 ? <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>{needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}</div> : matches.map((entry, index) => {
          const active = index === activeIndex;
          const name = entry.path.split("/").pop() ?? entry.path;
          const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
          return <button key={`${entry.isDir ? "d" : "f"}:${entry.path}`} ref={(node) => { itemRefs.current[index] = node; }} type="button"
            onMouseDown={(event) => { event.preventDefault(); onSelect(entry); }} onMouseEnter={() => onActiveIndexChange(index)}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "none", borderRadius: 6, background: active ? "var(--bg-selected)" : "none", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
            <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}{name}{entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}</span>
          </button>;
        })}
      </div>
    </div>
  );
});
