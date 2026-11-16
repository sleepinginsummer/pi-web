"use client";

// 回收站展示当前分支的完整历史；工具过程按回合折叠，阅读导航复用主聊天大纲。
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { MessageView } from "./MessageView";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { TrashSessionActions, trashButtonStyle } from "./TrashSessionActions";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { getTurnDurationMs } from "@/lib/turn-duration";
import { buildMessageRenderGroups } from "@/lib/message-render-groups";
import { collapsesProcessDetails, countToolCallBlocks, getDisplayableAssistantBlocks, isHiddenCustomMessage, isMessageGroupAnchor } from "@/lib/message-display";
import { getFinalAnswerViews } from "@/lib/turn-views";
import type { AgentMessage, AssistantMessage, SessionContext, ToolResultMessage } from "@/lib/types";
import type { TrashedSession } from "@/lib/trash";

interface Props {
  session: TrashedSession;
  onClose: () => void;
  onRestored: () => void;
  onRenamed: (session: TrashedSession) => void;
}

const noStreamingMessage = () => null;
const noRevealHistory = () => {};

export function TrashSessionDetail({ session, onClose, onRestored, onRenamed }: Props) {
  const { t, locale } = useI18n();
  const zh = locale.startsWith("zh");
  const [context, setContext] = useState<SessionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  useEffect(() => { setPortalTarget(document.body); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setError(null);
    fetch(`/api/trash/${encodeURIComponent(session.fileName)}/content`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { context?: SessionContext; error?: string };
        if (!response.ok || !data.context) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) setContext(data.context);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [session.fileName]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !restoring) onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, restoring]);

  const { messages, toolResults, groups, finalViews } = useMemo(() => {
    const messages = context?.messages ?? [];
    const toolResults = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
    }
    const { groups } = buildMessageRenderGroups(messages, {
      isAnchor: isMessageGroupAnchor,
      findFinalAssistantIndex: (items, start, end) => {
        for (let index = end - 1; index > start; index--) {
          if (items[index].role === "assistant") return index;
        }
        return -1;
      },
      busy: false, lastAnchorIndex: -1,
    });
    const cache = new WeakMap();
    const finalViews = new Map(groups.flatMap((group) => group.finalAssistantIdx < 0 ? [] : [[
      group.finalAssistantIdx, getFinalAnswerViews(cache, messages[group.finalAssistantIdx] as AssistantMessage),
    ] as const]));
    return { messages, toolResults, groups, finalViews };
  }, [context]);
  // 大纲的 ref 索引只计用户锚点与 assistant，工具结果不占位。
  const refIndices = useMemo(() => {
    let next = 0;
    return messages.map((message) => isMessageGroupAnchor(message) || message.role === "assistant" ? next++ : -1);
  }, [messages]);
  const messageRefs = useMessageRefs(refIndices.filter((index) => index >= 0).length);

  const handleRestore = async () => {
    setRestoring(true);
    setError(null);
    try {
      const response = await fetch(`/api/trash/${encodeURIComponent(session.fileName)}`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      onRestored();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setRestoring(false); }
  };

  const renderMessage = (message: AgentMessage, index: number, final = false) => (
    <div key={context?.entryIds[index] ?? index} data-entry-id={context?.entryIds[index]}
      ref={(element) => { if (refIndices[index] >= 0) messageRefs.current[refIndices[index]] = element; }}>
      <MessageView message={message} toolResults={toolResults} cwd={session.cwd} showTimestamp={final}
        prevTimestamp={index > 0 ? messages[index - 1].timestamp : undefined} />
    </div>
  );

  if (!portalTarget) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "min(3vw, 24px)" }}
      onClick={(event) => { if (event.target === event.currentTarget && !restoring) onClose(); }}>
      <div className="chat-content" role="dialog" aria-modal="true" aria-label={session.title} style={{ width: 1100, maxWidth: "100%", height: "90dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ flex: "1 1 180px", minWidth: 0, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 }} title={session.title}>{session.title}</strong>
          <TrashSessionActions session={session} onRenamed={onRenamed} disabled={restoring} />
          <button style={trashButtonStyle} aria-pressed={showOutline} onClick={() => setShowOutline(!showOutline)}>{zh ? "大纲" : "Outline"}</button>
          <button style={trashButtonStyle} disabled={restoring} onClick={() => void handleRestore()}>{t("trash.restore")}</button>
          <button style={trashButtonStyle} disabled={restoring} aria-label={zh ? "关闭" : "Close"} onClick={onClose}>×</button>
        </div>
        {error && <div role="alert" style={{ padding: "8px 16px", color: "#ef4444", fontSize: 12 }}>{error}</div>}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
          <div ref={scrollContainer} className="scrollbar-subtle" style={{ flex: 1, minWidth: 0, overflowX: "hidden", overflowY: "auto", padding: "16px", scrollbarGutter: "stable" }}>
            <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {context === null && !error ? <div style={{ padding: 18 }}>{t("i18n.loading")}</div>
              : messages.length === 0 ? <div style={{ padding: 18 }}>{t("trash.detailEmpty")}</div>
              : groups.map((group) => {
                const anchor = isMessageGroupAnchor(messages[group.start]);
                const views = finalViews.get(group.finalAssistantIdx);
                const processStart = anchor ? group.start + 1 : group.start;
                const process = [] as { message: AgentMessage; index: number }[];
                for (let index = processStart; index < group.end; index++) {
                  const message = index === group.finalAssistantIdx ? views!.process : messages[index];
                  if (message.role === "toolResult" || isHiddenCustomMessage(message)) continue;
                  if (message.role === "assistant" && getDisplayableAssistantBlocks(message).length === 0) continue;
                  process.push({ message, index });
                }
                return <div key={context?.entryIds[group.start] ?? group.start}>
                  {anchor && renderMessage(messages[group.start], group.start)}
                  {process.length > 0 && <ProcessDetailsGroup
                    messageCount={process.length}
                    toolCallCount={process.reduce((count, { message }) => count + (message.role === "assistant" ? countToolCallBlocks(message.content) : 0), 0)}
                    durationMs={anchor ? getTurnDurationMs(messages, group.start, group.end) : undefined}
                    defaultExpanded={!collapsesProcessDetails(views?.answer ?? null)}
                    t={t}
                    renderChildren={() => <>{process.map(({ message, index }) => renderMessage(message, index))}</>}
                  /> }
                  {views?.answer && renderMessage(views.answer, group.finalAssistantIdx, true)}
                </div>;
              })}
            </div>
          </div>
          {showOutline && context && <ChatMinimap messages={messages} entryIds={context.entryIds}
            getStreamingMessage={noStreamingMessage} isStreaming={false} scrollContainer={scrollContainer}
            messageRefs={messageRefs} onRevealHistory={noRevealHistory} turnsBefore={0} />}
        </div>
      </div>
    </div>, portalTarget,
  );
}
