"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "@/lib/markdown";
import { hasTurnRef, isHiddenCustomMessage, splitFinalAssistantBlocks } from "@/lib/message-display";
import { hasOutlineHeadings } from "@/lib/outline-headings";
import { loadMinimapPreviewLocked, saveMinimapPreviewLocked } from "@/lib/minimap-preview-lock";
import type { SessionOutlineResponse, SessionOutlineTurn } from "@/lib/session-outline-types";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent, UserMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ChatMinimap.module.css";
import { LockToggle } from "./LockToggle";

interface Props {
  sessionId?: string | null;
  leafId?: string | null;
  messages: AgentMessage[];
  entryIds: string[];
  /** 在节流测量时读取正文，不随每个 chunk 更新 props。 */
  getStreamingMessage: () => Partial<AgentMessage> | null;
  isStreaming: boolean;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onNavigate?: () => void;
  /** entryId 给出时，把该轮次所在的消息组挂进渲染窗口（长会话只挂载最近一段）。 */
  onRevealHistory: (entryId?: string) => void;
  /** 按需向前翻页直到加载出指定 entryId（仅在用户双击或点击「跳到对话」时调用）。 */
  onLoadUntilEntry?: (entryId: string) => Promise<boolean>;
  /** Turns of the branch the server has not sent yet: numbers continue from it (#791). */
  turnsBefore: number;
  /** ChatWindow's getTurnAnchors() over `messages`: the minimap groups and reads refs as it renders. */
  turnAnchors: readonly boolean[];
}

const PREVIEW_HIDE_DELAY = 260;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;
const MAX_PILL_TICKS = 28;

interface AssistantPreview {
  markdown: string;
  entryId?: string;
  element: HTMLDivElement | null;
}

interface TurnInfo {
  entryId?: string;
  userMessage: UserMessage | CustomMessage;
  /** 1-A：仅保留本轮最终回答，过滤中途过程回复。 */
  finalAssistant: AssistantPreview | null;
  scrollTop: number | null;
  /** Tool calls issued anywhere in this turn's assistant replies. */
  toolCount: number;
}

interface NodeInfo {
  targetTurn: TurnInfo;
  index: number;
  /** 会话中的轮次编号（从 1 开始），与 index 在同一次测量中确定，避免起点与下标来自不同时刻。 */
  turnNumber: number;
}

function getUserPreview(message: UserMessage | CustomMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Tool calls in one assistant message. A reply can both answer and call
 *  tools, so this counts blocks rather than text-less messages. */
export function countToolCalls(message: AgentMessage | Partial<AgentMessage>): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.reduce(
    (total, block) => total + (block.type === "toolCall" ? 1 : 0),
    0,
  );
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** 分组折叠时同一消息可能有“过程”和“最终回答”两个 DOM 节点；标题定位必须选实际含标题的节点。 */
function findRenderedHeadingRoot(scrollEl: HTMLElement, preview: AssistantPreview | null | undefined): HTMLElement | null {
  if (!preview?.entryId) return preview?.element ?? null;
  const roots = scrollEl.querySelectorAll<HTMLElement>(`[data-entry-id="${CSS.escape(preview.entryId)}"]`);
  return Array.from(roots).find((root) => root.querySelector("h1, h2")) ?? preview.element;
}

function PreviewHeading({
  level,
  children,
  headingIndex,
  onClick,
}: {
  level: 1 | 2;
  children: React.ReactNode;
  headingIndex: number | null;
  onClick?: (headingIndex: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.heading}
      data-level={level}
      data-preview-heading-index={headingIndex ?? undefined}
      disabled={headingIndex === null || !onClick}
      onClick={(event) => {
        event.stopPropagation();
        if (headingIndex !== null) onClick?.(headingIndex);
      }}
    >
      {children}
    </button>
  );
}

interface PreviewAstNode {
  type?: string;
  depth?: number;
  data?: {
    hProperties?: Record<string, unknown>;
  };
}

/** 1-A 大纲仅提取一级/二级标题，避免 h3 和正文段落挤满大纲。 */
function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter((node) => (
      node.type === "heading" && typeof node.depth === "number" && node.depth <= 2
    ));
    headings.forEach((node, headingIndex) => {
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-preview-heading-index": headingIndex,
        },
      };
    });
    tree.children = headings;
  };
}

const previewRemarkPlugins = [
  ...(markdownPreviewRemarkPlugins ?? []),
  remarkPreviewOutline,
];
const previewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];

function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.["data-preview-heading-index"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export const AssistantOutline = memo(function AssistantOutline({
  markdown,
  onHeadingClick,
}: {
  markdown: string;
  onHeadingClick?: (headingIndex: number) => void;
  onAnswerClick?: () => void;
}) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  const components = useMemo<ReactMarkdownOptions["components"]>(() => ({
    h1: ({ node, children }) => (
      <PreviewHeading level={1} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>
        {children}
      </PreviewHeading>
    ),
    h2: ({ node, children }) => (
      <PreviewHeading level={2} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>
        {children}
      </PreviewHeading>
    ),
    a: ({ children }) => <span>{children}</span>,
  }), [onHeadingClick]);

  if (!normalizedMarkdown) return null;

  return (
    <div className={styles.outline}>
      <ReactMarkdown
        remarkPlugins={previewRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

function createTurnNodes(turns: TurnInfo[], turnsBefore: number): NodeInfo[] {
  return turns.map((turn, index) => ({
    targetTurn: turn,
    index,
    turnNumber: turnsBefore + index + 1,
  }));
}

function formatTurnNumber(turnNumber: number): string {
  return turnNumber < 10 ? `0${turnNumber}` : String(turnNumber);
}

/** 将超长会话压缩到最多 MAX_PILL_TICKS 个刻度，始终保留首轮和当前轮。 */
function sampleRailTicks(
  unloadedCount: number,
  loadedNodes: readonly NodeInfo[],
  activeIndex: number | null,
): Array<{ key: string; loaded: boolean; active: boolean; nodeIndex?: number }> {
  const ticks: Array<{ key: string; loaded: boolean; active: boolean; nodeIndex?: number }> = [];
  if (loadedNodes.length === 0) return ticks;

  const unloadedSlotBudget = unloadedCount > 0 ? Math.min(8, unloadedCount, Math.floor(MAX_PILL_TICKS / 3)) : 0;
  for (let i = 0; i < unloadedSlotBudget; i += 1) {
    ticks.push({ key: `u-${i}`, loaded: false, active: false });
  }

  const loadedBudget = Math.max(2, MAX_PILL_TICKS - unloadedSlotBudget);
  if (loadedNodes.length <= loadedBudget) {
    for (const node of loadedNodes) {
      ticks.push({
        key: `l-${node.index}`,
        loaded: true,
        active: activeIndex === node.index,
        nodeIndex: node.index,
      });
    }
    return ticks;
  }

  const picked = new Set<number>([0, loadedNodes.length - 1]);
  if (activeIndex !== null && activeIndex >= 0 && activeIndex < loadedNodes.length) {
    picked.add(activeIndex);
  }
  const step = (loadedNodes.length - 1) / (loadedBudget - 1);
  for (let slot = 0; slot < loadedBudget && picked.size < loadedBudget; slot += 1) {
    picked.add(Math.round(slot * step));
  }
  const sorted = [...picked].sort((a, b) => a - b);
  for (const idx of sorted) {
    const node = loadedNodes[idx];
    ticks.push({
      key: `l-${node.index}`,
      loaded: true,
      active: activeIndex === node.index,
      nodeIndex: node.index,
    });
  }
  return ticks;
}

export const ChatMinimap = memo(function ChatMinimap({
  sessionId,
  leafId,
  messages,
  entryIds,
  getStreamingMessage,
  isStreaming,
  scrollContainer,
  messageRefs,
  onNavigate,
  onRevealHistory,
  onLoadUntilEntry,
  turnsBefore,
  turnAnchors,
}: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewListRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const headingAnchorRef = useRef<{ heading: HTMLElement; until: number } | null>(null);
  const searchFocusedRef = useRef(false);
  const pendingNavigationRef = useRef<{
    nodeIndex?: number;
    entryId?: string;
    target: "user" | "heading";
    headingIndex?: number;
  } | null>(null);

  const [visible, setVisible] = useState(false);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [locked, setLocked] = useState(() => loadMinimapPreviewLocked());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [allNodes, setAllNodes] = useState<NodeInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  /** 手动展开或收起记录：正数表示展开对应轮次，负数表示手动折叠当前激活轮。 */
  const [toggledTurns, setToggledTurns] = useState<Set<number>>(() => new Set());
  const [remoteOutline, setRemoteOutline] = useState<{ key: string; turns: SessionOutlineTurn[] } | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [loadingEntryId, setLoadingEntryId] = useState<string | null>(null);
  /** 按需加载没能把目标轮次带进来时的提示，避免点了大纲却停在原地。 */
  const [revealFailed, setRevealFailed] = useState(false);

  const allNodesRef = useRef<NodeInfo[]>([]);
  const messagesRef = useRef(messages);
  const entryIdsRef = useRef(entryIds);
  const turnsBeforeRef = useRef(turnsBefore);
  const turnAnchorsRef = useRef(turnAnchors);
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  turnsBeforeRef.current = turnsBefore;
  turnAnchorsRef.current = turnAnchors;


  // 正在按需加载的轮次：异步回调里判断这次加载是否还有效（会话切走后不再提示）。
  const jumpTargetRef = useRef<string | null>(null);

  const outlineRequestKey = sessionId ? `${sessionId}:${leafId ?? ""}:${turnsBefore}` : "";

  // 切换会话或分支时清空大纲本地筛选与展开状态。
  useEffect(() => {
    setSearchQuery("");
    setToggledTurns(new Set());
    setLoadingEntryId(null);
    setRevealFailed(false);
    jumpTargetRef.current = null;
    setRemoteOutline(null);
  }, [sessionId, leafId]);

  // 打开大纲且存在未加载历史时，按需向服务端拉取全分支轻量目录（不触发主对话翻页）。
  useEffect(() => {
    if (!minimapHovered || !sessionId || turnsBefore <= 0) return;
    if (remoteOutline?.key === outlineRequestKey) return;
    const controller = new AbortController();
    setOutlineLoading(true);
    const params = leafId ? `?leafId=${encodeURIComponent(leafId)}` : "";
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/outline${params}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as SessionOutlineResponse;
        if (!controller.signal.aborted) {
          setRemoteOutline({ key: outlineRequestKey, turns: Array.isArray(payload.turns) ? payload.turns : [] });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("[pi-web] 无法加载会话全量大纲", error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOutlineLoading(false);
      });
    return () => controller.abort();
  }, [leafId, minimapHovered, outlineRequestKey, remoteOutline?.key, sessionId, turnsBefore]);

  const unloadedOutlineTurns = useMemo(() => {
    if (turnsBefore <= 0 || !remoteOutline || remoteOutline.key !== outlineRequestKey) return [];
    const loadedIdSet = new Set(entryIds);
    return remoteOutline.turns.filter((turn) => turn.turnNumber <= turnsBefore && !loadedIdSet.has(turn.entryId));
  }, [entryIds, outlineRequestKey, remoteOutline, turnsBefore]);

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
    onNavigate?.();
  }, [onNavigate]);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;

    const measuredNodes = nextNodes.filter((node) => node.targetTurn.scrollTop !== null);
    if (measuredNodes.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nextActiveNode = measuredNodes.reduce((bestNode, node) => (
      Math.abs((node.targetTurn.scrollTop ?? 0) - focusTop)
        < Math.abs((bestNode.targetTurn.scrollTop ?? 0) - focusTop)
        ? node
        : bestNode
    ), measuredNodes[0]);
    setActiveIndex(nextActiveNode.index);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    setVisible(scrollable > 20 || turnsBeforeRef.current > 0 || allNodesRef.current.length > 0);
    syncActiveNode(scrollEl, allNodesRef.current);
  }, [scrollContainer, syncActiveNode]);

  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      const turns: TurnInfo[] = [];
      let refIndex = 0;
      let currentTurn: TurnInfo | null = null;

      const streamingMessage = getStreamingMessage();
      const allMessages: (AgentMessage | Partial<AgentMessage>)[] = streamingMessage
        ? [...messagesRef.current, streamingMessage]
        : messagesRef.current;
      for (const [messageIndex, message] of allMessages.entries()) {
        const isAnchor = turnAnchorsRef.current[messageIndex] ?? false;
        if (!isAnchor && message.role !== "assistant") continue;
        // ChatWindow's refs, in the same order: a hidden anchor renders nothing and has none.
        let element: HTMLDivElement | null = null;
        if (hasTurnRef(message, isAnchor)) {
          element = refs?.[refIndex] ?? null;
          refIndex += 1;
        }

        if (isAnchor) {
          const elementRect = element?.getBoundingClientRect();
          currentTurn = {
            entryId: entryIdsRef.current[messageIndex],
            userMessage: message as UserMessage | CustomMessage,
            finalAssistant: null,
            scrollTop: elementRect
              ? elementRect.top - containerRect.top + scrollEl.scrollTop
              : null,
            toolCount: 0,
          };
          turns.push(currentTurn);
          continue;
        }

        if (!currentTurn) continue;
        // A turn a hidden message opened starts where its first reply shows.
        if (currentTurn.scrollTop === null && element && isHiddenCustomMessage(currentTurn.userMessage)) {
          currentTurn.scrollTop = element.getBoundingClientRect().top - containerRect.top + scrollEl.scrollTop;
        }
        currentTurn.toolCount += countToolCalls(message);
        const answerMarkdown = getAssistantAnswerMarkdown(message);
        if (answerMarkdown) {
          // 1-A：每轮只保留最后一条最终回答，过滤中途过程回复。
          currentTurn.finalAssistant = {
            markdown: answerMarkdown,
            entryId: entryIdsRef.current[messageIndex],
            element,
          };
        }
      }

      const nextNodes = createTurnNodes(turns, turnsBeforeRef.current);
      allNodesRef.current = nextNodes;
      setAllNodes(nextNodes);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20 || turnsBeforeRef.current > 0 || nextNodes.length > 0);
      syncActiveNode(scrollEl, nextNodes);

      const pendingNavigation = pendingNavigationRef.current;
      if (pendingNavigation) {
        const pendingNode = pendingNavigation.entryId
          ? nextNodes.find((node) => node.targetTurn.entryId === pendingNavigation.entryId)
          : (pendingNavigation.nodeIndex !== undefined ? nextNodes[pendingNavigation.nodeIndex] : null);
        if (pendingNode) {
          let targetTop: number | null = pendingNode.targetTurn.scrollTop;
          if (pendingNavigation.target === "heading") {
            const heading = (
              pendingNavigation.headingIndex === undefined
                ? null
                : findRenderedHeadingRoot(scrollEl, pendingNode.targetTurn.finalAssistant)
                  ?.querySelectorAll<HTMLElement>("h1, h2")
                  .item(pendingNavigation.headingIndex)
            );
            const headingRect = heading?.getBoundingClientRect();
            targetTop = headingRect
              ? headingRect.top - containerRect.top + scrollEl.scrollTop
              : null;
          }
          if (targetTop !== null) {
            pendingNavigationRef.current = null;
            lockActiveNode(pendingNode.index);
            const targetOffset = scrollEl.clientHeight * 0.3;
            scrollEl.scrollTo({
              top: Math.max(0, targetTop - targetOffset),
              behavior: "smooth",
            });
          }
        }
      }
    }, 100);
  }, [getStreamingMessage, lockActiveNode, messageRefs, scrollContainer, syncActiveNode]);

  useEffect(() => {
    measureNodes();
    return () => {
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [messages, entryIds, isStreaming, turnsBefore, turnAnchors, measureNodes]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const onScroll = () => updateScroll();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      updateScroll();
      if (!isStreaming) measureNodes();
    });
    ro.observe(scrollEl);
    if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
    updateScroll();
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [isStreaming, scrollContainer, updateScroll, measureNodes]);

  const scrollToNode = useCallback((node: NodeInfo, behavior: ScrollBehavior = "smooth") => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    if (node.targetTurn.scrollTop === null) {
      pendingNavigationRef.current = { nodeIndex: node.index, target: "user" };
      onRevealHistory(node.targetTurn.entryId);
      return;
    }
    const targetOffset = scrollEl.clientHeight * 0.3;
    lockActiveNode(node.index);
    scrollEl.scrollTo({
      top: Math.max(0, node.targetTurn.scrollTop - targetOffset),
      behavior,
    });
  }, [lockActiveNode, onRevealHistory, scrollContainer]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const alignHeading = () => {
      const anchor = headingAnchorRef.current;
      if (!anchor) return;
      if (Date.now() >= anchor.until || !anchor.heading.isConnected) {
        headingAnchorRef.current = null;
        return;
      }
      const expected = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.3;
      const delta = anchor.heading.getBoundingClientRect().top - expected;
      if (Math.abs(delta) > 2) scrollEl.scrollTo({ top: scrollEl.scrollTop + delta, behavior: "instant" });
    };
    const cancelAnchor = () => { headingAnchorRef.current = null; };
    const cancelOnScrollKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
        && !(event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']"))) {
        cancelAnchor();
      }
    };
    const observer = new ResizeObserver(alignHeading);
    if (scrollEl.firstElementChild) observer.observe(scrollEl.firstElementChild);
    observer.observe(scrollEl);
    scrollEl.addEventListener("scrollend", alignHeading);
    window.addEventListener("keydown", cancelOnScrollKey);
    scrollEl.addEventListener("wheel", cancelAnchor, { passive: true });
    scrollEl.addEventListener("touchstart", cancelAnchor, { passive: true });
    scrollEl.addEventListener("pointerdown", cancelAnchor, { passive: true });
    return () => {
      observer.disconnect();
      scrollEl.removeEventListener("scrollend", alignHeading);
      window.removeEventListener("keydown", cancelOnScrollKey);
      scrollEl.removeEventListener("wheel", cancelAnchor);
      scrollEl.removeEventListener("touchstart", cancelAnchor);
      scrollEl.removeEventListener("pointerdown", cancelAnchor);
    };
  }, [scrollContainer]);

  const scrollToHeading = useCallback((node: NodeInfo, headingIndex: number) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const answerElement = findRenderedHeadingRoot(scrollEl, node.targetTurn.finalAssistant);
    if (!answerElement) {
      pendingNavigationRef.current = {
        nodeIndex: node.index,
        target: "heading",
        headingIndex,
      };
      onRevealHistory(node.targetTurn.entryId);
      return;
    }
    const heading = answerElement.querySelectorAll<HTMLElement>("h1, h2").item(headingIndex);
    if (!heading) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const targetTop = headingRect.top - containerRect.top + scrollEl.scrollTop - scrollEl.clientHeight * 0.3;
    lockActiveNode(node.index);
    // 首次跳转后内容仍可能补页或重新排版；短暂锚定标题，防止异步布局把阅读位置拉偏。
    headingAnchorRef.current = { heading, until: Date.now() + 2000 };
    scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [lockActiveNode, onRevealHistory, scrollContainer]);

  const jumpToUnloadedTurn = useCallback(async (turn: SessionOutlineTurn) => {
    if (loadingEntryId) return;
    onNavigate?.();
    if (!onLoadUntilEntry) {
      scrollContainer.current?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setLoadingEntryId(turn.entryId);
    setRevealFailed(false);
    jumpTargetRef.current = turn.entryId;
    pendingNavigationRef.current = { entryId: turn.entryId, target: "user" };
    try {
      const loaded = await onLoadUntilEntry(turn.entryId);
      if (loaded) {
        onRevealHistory(turn.entryId);
        measureNodes();
      } else {
        pendingNavigationRef.current = null;
        // 真的没找到才提示；会话切走时 jumpTargetRef 已清空，不弹无意义的错误。
        if (jumpTargetRef.current === turn.entryId) setRevealFailed(true);
      }
    } finally {
      if (jumpTargetRef.current === turn.entryId) jumpTargetRef.current = null;
      setLoadingEntryId(null);
    }
  }, [loadingEntryId, measureNodes, onLoadUntilEntry, onNavigate, onRevealHistory, scrollContainer]);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback(() => {
    if (locked) return;
    setRevealFailed(false);
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide, locked]);

  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    saveMinimapPreviewLocked(next);
    if (next) {
      cancelPreviewHide();
      setMinimapHovered(false);
    }
  }, [cancelPreviewHide, locked]);

  const schedulePreviewHide = useCallback(() => {
    if (searchFocusedRef.current) return;
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      if (!searchFocusedRef.current) setMinimapHovered(false);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  // 刚打开大纲时把当前所在轮滚进可视区，方便直接看到上下文位置。
  useEffect(() => {
    if (!minimapHovered || activeIndex === null || searchQuery.trim()) return;
    const targetItem = previewItemRefs.current.get(activeIndex);
    if (!targetItem) return;
    targetItem.scrollIntoView({ block: "nearest" });
  }, [minimapHovered, activeIndex, searchQuery]);

  const toggleTurnExpanded = useCallback((turnNumber: number, isActiveLoaded: boolean) => {
    setToggledTurns((prev) => {
      const next = new Set(prev);
      const key = isActiveLoaded ? -turnNumber : turnNumber;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredUnloadedTurns = useMemo(() => {
    if (!normalizedQuery) return unloadedOutlineTurns;
    return unloadedOutlineTurns.filter((turn) => (
      turn.userText.toLowerCase().includes(normalizedQuery)
      || turn.answerSummary.toLowerCase().includes(normalizedQuery)
      || turn.headings.some((heading) => heading.text.toLowerCase().includes(normalizedQuery))
      || String(turn.turnNumber).includes(normalizedQuery)
    ));
  }, [normalizedQuery, unloadedOutlineTurns]);

  const filteredLoadedNodes = useMemo(() => {
    if (!normalizedQuery) return allNodes;
    return allNodes.filter((node) => {
      const userText = isHiddenCustomMessage(node.targetTurn.userMessage)
        ? t("chatMinimap.extensionTurn", { type: (node.targetTurn.userMessage as CustomMessage).customType })
        : getUserPreview(node.targetTurn.userMessage);
      const answerText = node.targetTurn.finalAssistant?.markdown ?? "";
      return userText.toLowerCase().includes(normalizedQuery)
        || answerText.toLowerCase().includes(normalizedQuery)
        || String(node.turnNumber).includes(normalizedQuery);
    });
  }, [allNodes, normalizedQuery, t]);

  const railTicks = useMemo(
    () => sampleRailTicks(turnsBefore, allNodes, activeIndex),
    [turnsBefore, allNodes, activeIndex],
  );

  const totalTurnCount = turnsBefore + allNodes.length;
  const matchedTurnCount = filteredUnloadedTurns.length + filteredLoadedNodes.length;

  if (!visible || totalTurnCount === 0) return null;

  return (
    <div
      ref={containerRef}
      className={styles.rail}
      data-open={minimapHovered ? "true" : undefined}
    >
      <div
        className={styles.pill}
        onMouseEnter={showPreview}
        onMouseLeave={schedulePreviewHide}
      >
        {turnsBefore > 0 && <span data-minimap-earlier="" style={{ display: "none" }} />}
        <div className={styles.ticks}>
          {railTicks.map((tick) => (
            <div
              key={tick.key}
              className={styles.tickWrap}
              data-minimap-node-index={tick.nodeIndex}
              data-minimap-node-active={tick.active ? "" : undefined}
            >
              <span
                className={`${styles.tick} ${tick.loaded ? styles.tickLoaded : ""} ${tick.active ? styles.tickActive : ""}`}
              />
            </div>
          ))}
        </div>
        <div className={styles.pillDivider} />
        <LockToggle
          locked={locked}
          className={styles.lock}
          data-minimap-lock={locked ? "on" : "off"}
          title={t(locked ? "chatMinimap.unlockPreview" : "chatMinimap.lockPreview")}
          aria-label={t("chatMinimap.lockPreview")}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleLock();
          }}
        />
      </div>

      {minimapHovered && totalTurnCount > 0 && (
        <div
          ref={previewBoxRef}
          className={styles.preview}
          data-minimap-preview-box=""
          onMouseEnter={showPreview}
          onMouseLeave={schedulePreviewHide}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className={styles.header}>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className={styles.searchInput}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => { searchFocusedRef.current = true; cancelPreviewHide(); }}
                onBlur={() => { searchFocusedRef.current = false; }}
                placeholder={t("chatMinimap.searchPlaceholder", { count: totalTurnCount })}
                aria-label={t("chatMinimap.searchPlaceholder", { count: totalTurnCount })}
              />
            </div>
            <span className={styles.searchCount}>
              {normalizedQuery ? `${matchedTurnCount}/${totalTurnCount}` : totalTurnCount}
            </span>
          </div>

          <div className={styles.subhint}>
            <span>{t("chatMinimap.clickHint")}</span>
            {outlineLoading && <span>{t("chatMinimap.loadingOutline")}</span>}
            {revealFailed && (
              <span className={styles.revealFailed} role="status">{t("chatMinimap.revealFailed")}</span>
            )}
          </div>

          <div ref={previewListRef} className={styles.list}>
            {/* 全量目录未就绪或无 sessionId 时回退到早先分页提示 */}
            {turnsBefore > 0 && unloadedOutlineTurns.length === 0 && !normalizedQuery && (
              <button
                type="button"
                className={styles.earlier}
                data-minimap-preview-earlier=""
                onClick={() => scrollContainer.current?.scrollTo({ top: 0, behavior: "smooth" })}
              >
                {t("chatMinimap.earlierTurns", { count: turnsBefore })}
              </button>
            )}

            {/* 2-B：全量未加载历史轮次（单击大纲内预览摘要，双击或点按钮才按需加载并跳转） */}
            {filteredUnloadedTurns.map((turn) => {
              const isExpanded = toggledTurns.has(turn.turnNumber);
              const isLoadingThis = loadingEntryId === turn.entryId;
              const labelText = turn.hiddenAnchor
                ? t("chatMinimap.extensionTurn", { type: turn.customType ?? "custom" })
                : (turn.userText || (turn.customType ? t("chatMinimap.extensionTurn", { type: turn.customType }) : ""));
              return (
                <div
                  key={`outline-${turn.entryId}`}
                  className={`${styles.turn} ${styles.turnUnloaded}`}
                  data-minimap-outline-entry={turn.entryId}
                >
                  <button
                    type="button"
                    className={styles.turnRow}
                    onClick={() => toggleTurnExpanded(turn.turnNumber, false)}
                    onDoubleClick={() => void jumpToUnloadedTurn(turn)}
                  >
                    <span className={styles.number}>
                      <span aria-hidden="true">{formatTurnNumber(turn.turnNumber)}</span>
                    </span>
                    <span className={styles.userText}>{labelText}</span>
                    <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ""}`} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className={styles.previewCard}>
                      {labelText && <div className={styles.previewCardQuestion}>{labelText}</div>}
                      <div className={styles.previewCardSummary}>
                        {turn.answerSummary || t("chatMinimap.noAnswerSummary")}
                      </div>
                      {turn.headings.length > 0 && (
                        <div className={styles.previewCardTags}>
                          {turn.headings.map((heading, idx) => (
                            <span key={idx} className={styles.previewTag}>{heading.text}</span>
                          ))}
                        </div>
                      )}
                      <div className={styles.previewCardFooter}>
                        <span className={styles.previewCardNote}>{t("chatMinimap.unloadedNote")}</span>
                        <button
                          type="button"
                          className={styles.jumpBtn}
                          disabled={loadingEntryId !== null}
                          onClick={() => void jumpToUnloadedTurn(turn)}
                        >
                          {isLoadingThis ? t("chatMinimap.loadingTurn") : t("chatMinimap.jumpToChat")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredUnloadedTurns.length > 0 && filteredLoadedNodes.length > 0 && (
              <div className={styles.divider} data-minimap-preview-earlier="">
                {t("chatMinimap.loadedDivider")}
              </div>
            )}

            {/* 1-A：已加载轮次，仅当前所在轮默认展开最终回答的 h1/h2，单击展开/折叠、双击跳转 */}
            {filteredLoadedNodes.map((node) => {
              const isActive = activeIndex === node.index;
              const finalAssistant = node.targetTurn.finalAssistant;
              const hasHeadings = Boolean(finalAssistant && hasOutlineHeadings(finalAssistant.markdown));
              const isExpanded = hasHeadings && (
                isActive ? !toggledTurns.has(-node.turnNumber) : toggledTurns.has(node.turnNumber)
              );
              const userText = isHiddenCustomMessage(node.targetTurn.userMessage)
                ? t("chatMinimap.extensionTurn", { type: (node.targetTurn.userMessage as CustomMessage).customType })
                : getUserPreview(node.targetTurn.userMessage);
              return (
                <div
                  key={node.index}
                  ref={(element) => {
                    if (element) previewItemRefs.current.set(node.index, element);
                    else previewItemRefs.current.delete(node.index);
                  }}
                  className={styles.turn}
                  data-minimap-preview-index={node.index}
                  data-located={isActive ? "true" : undefined}
                >
                  <button
                    type="button"
                    className={styles.turnRow}
                    data-minimap-preview-user={node.index}
                    onClick={() => {
                      if (hasHeadings) toggleTurnExpanded(node.turnNumber, isActive);
                    }}
                    onDoubleClick={() => scrollToNode(node, "smooth")}
                  >
                    <span className={styles.number}>
                      <span aria-hidden="true">{formatTurnNumber(node.turnNumber)}</span>
                    </span>
                    <span className={styles.userText}>{userText}</span>
                    {hasHeadings && (
                      <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ""}`} aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    )}
                  </button>

                  {isExpanded && finalAssistant && (
                    <div className={styles.headingsWrap}>
                      <AssistantOutline
                        markdown={finalAssistant.markdown}
                        onHeadingClick={(headingIndex) => scrollToHeading(node, headingIndex)}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {matchedTurnCount === 0 && (
              <div className={styles.emptyState}>{t("chatMinimap.noMatches")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
