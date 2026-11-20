"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "@/lib/markdown";
import { hasTurnRef, isHiddenCustomMessage, splitFinalAssistantBlocks } from "@/lib/message-display";
import { cachedHasOutlineHeadings, hasOutlineHeadings, joinAnswerBlocks } from "@/lib/outline-headings";
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
  /** 最终回答的正文（文本块按块边界拼接，围栏不跨块），用于搜索。 */
  markdown: string;
  /** 按正文渲染顺序排列的文本块；预览按块渲染，标题编号与正文一致。 */
  blocks: AssistantAnswerBlock[];
  entryId?: string;
  element: HTMLDivElement | null;
  /** 正在流式输出的这条回复：正文每帧都变，不用进标题缓存。 */
  streaming?: boolean;
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

/**
 * 本轮最终回答的正文；没有回答时返回 null。
 *
 * 和主对话一样按「文本或图片」判断有没有回答：纯图片的答复也是回答，返回空正文，
 * 让上一段过程回复的标题从大纲里消失，而不是继续显示一个点不到的文字预览。
 * 保留原始缩进（四空格缩进的围栏是缩进代码），只用 trim 判断有没有正文。
 */
/** 最终回答里的一个文本块，`blockIndex` 是它在 `answerBlocks` 里的下标。 */
export interface AssistantAnswerBlock {
  blockIndex: number;
  text: string;
}

/**
 * 本轮最终回答的正文。`markdown` 用于搜索与摘要，`blocks` 用于逐块渲染与标题定位。
 *
 * 拼接后的整篇结构和逐块渲染的顶层结构可能不同（例如第二块以两格缩进的标题开头时，
 * 拼进前一块的列表里就成了嵌套），所以大纲预览必须按块渲染，编号也按块来算，
 * 点击时再用「块下标 + 块内标题下标」定位正文。
 */
export function getAssistantAnswer(
  message: AgentMessage | Partial<AgentMessage>,
): { markdown: string; blocks: AssistantAnswerBlock[] } | null {
  if (message.role !== "assistant") return null;
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  if (answerBlocks.length === 0) return null;
  const blocks: AssistantAnswerBlock[] = [];
  answerBlocks.forEach((block, blockIndex) => {
    if (block.type === "text") blocks.push({ blockIndex, text: block.text });
  });
  const markdown = joinAnswerBlocks(blocks.map((block) => block.text));
  return { markdown: markdown.trim() ? markdown : "", blocks };
}

/**
 * 本轮最终回答的正文；没有回答时返回 null。
 *
 * 和主对话一样按「文本或图片」判断有没有回答：纯图片的答复也是回答，返回空正文，
 * 让上一段过程回复的标题从大纲里消失，而不是继续显示一个点不到的文字预览。
 * 保留原始缩进（四空格缩进的围栏是缩进代码），只用 trim 判断有没有正文。
 */
export function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string | null {
  return getAssistantAnswer(message)?.markdown ?? null;
}

/**
 * 按消息对象缓存回答提取结果。
 *
 * `measureNodes` 在挂载、滚动、尺寸变化时都会跑（100ms 节流），每次都要对每条回答做
 * 一次 `joinAnswerBlocks`（逐块 split + 正则）。回答本身很少变，消息对象又是不可变的，
 * 所以用 WeakMap 缓存：消息被替换后旧值自动回收，也不占引用让它活着。
 *
 * 顺带让 `blocks` 的引用稳定下来：大纲预览里 `AssistantOutline` 按 `blocks` 做 memo，
 * 命中就整段跳过重新解析。
 */
const assistantAnswerCache = new WeakMap<object, ReturnType<typeof getAssistantAnswer>>();

export function cachedAssistantAnswer(message: AgentMessage | Partial<AgentMessage>) {
  const cached = assistantAnswerCache.get(message);
  if (cached !== undefined) return cached;
  const answer = getAssistantAnswer(message);
  assistantAnswerCache.set(message, answer);
  return answer;
}

/**
 * 正文里「算大纲标题」的那几个节点：只有最终回答渲染时会给顶层 h1/h2 打标记
 * （`lib/markdown.ts` 的 `remarkAnswerHeadingMarkers`），过程详情、引用块、
 * 原样 HTML 里的标题都不算，编号才和预览逐行一致。
 */
const ANSWER_HEADING_SELECTOR = "[data-answer-heading]";
/** 最终回答的容器标记（ChatWindow 给答复那一次渲染加的），用来在同一条消息的过程副本里挑对节点。 */
const ANSWER_CONTAINER_SELECTOR = "[data-answer]";

function answerHeadingElements(root: HTMLElement | null | undefined): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(ANSWER_HEADING_SELECTOR)];
}

/**
 * 同一条消息可能同时渲染「过程」和「最终回答」两个节点：先认 ChatWindow 给答复加的
 * `data-answer` 容器，其次才是含标题标记的节点（未拆分的过程与答复合成一个节点时），
 * 最后退回测量时记下的元素。只按“有没有 h1/h2”挑会选到过程详情里的标题。
 */
function findRenderedHeadingRoot(scrollEl: HTMLElement, preview: AssistantPreview | null | undefined): HTMLElement | null {
  if (!preview?.entryId) return preview?.element ?? null;
  const roots = Array.from(scrollEl.querySelectorAll<HTMLElement>(`[data-entry-id="${CSS.escape(preview.entryId)}"]`));
  return roots.find((root) => root.matches(ANSWER_CONTAINER_SELECTOR))
    ?? roots.find((root) => root.querySelector(ANSWER_HEADING_SELECTOR))
    ?? preview.element;
}

/**
 * 这个回答的标题现在点得动吗。
 *
 * 答复已经挂载时要求副本里真有标记（流式气泡、没打标记的渲染入口点了也找不到节点）；
 * 还没挂载（长会话只挂最近一段）时只要还有 entryId，可以先交给 onRevealHistory
 * 把那一组挂进来再定位。定位不到就不给可点的标题，免得点了像没反应。
 */
export function canLocateAnswerHeadings(preview: Pick<AssistantPreview, "element" | "entryId"> | null | undefined): boolean {
  if (!preview) return false;
  if (preview.element) return Boolean(preview.element.querySelector(ANSWER_HEADING_SELECTOR));
  return Boolean(preview.entryId);
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
  blocks,
  onHeadingClick,
}: {
  blocks: readonly AssistantAnswerBlock[];
  onHeadingClick?: (blockIndex: number, headingIndex: number) => void;
}) {
  // 逐块渲染：正文里每个文本块也是单独解析的，拼接后的顶层结构可能不同
  // （第二块以两格缩进开头时会被并进前一块的列表），编号必须按块算才对得上。
  const rendered = useMemo(() => blocks
    .filter((block) => block.text.trim())
    .map((block) => {
      const components: ReactMarkdownOptions["components"] = {
        h1: ({ node, children }) => (
          <PreviewHeading
            level={1}
            headingIndex={getPreviewHeadingIndex(node)}
            onClick={onHeadingClick ? (headingIndex) => onHeadingClick(block.blockIndex, headingIndex) : undefined}
          >
            {children}
          </PreviewHeading>
        ),
        h2: ({ node, children }) => (
          <PreviewHeading
            level={2}
            headingIndex={getPreviewHeadingIndex(node)}
            onClick={onHeadingClick ? (headingIndex) => onHeadingClick(block.blockIndex, headingIndex) : undefined}
          >
            {children}
          </PreviewHeading>
        ),
        a: ({ children }) => <span>{children}</span>,
      };
      return (
        <ReactMarkdown
          key={block.blockIndex}
          remarkPlugins={previewRemarkPlugins}
          rehypePlugins={previewRehypePlugins}
          components={components}
        >
          {normalizeDisplayMath(block.text)}
        </ReactMarkdown>
      );
    }), [blocks, onHeadingClick]);

  if (rendered.length === 0) return null;

  return <div className={styles.outline}>{rendered}</div>;
});

/** 两次测量的结果是否等价：滚动位置、条目、回答和元素都没变就不用重渲染。 */
function sameTurnNodes(previous: readonly NodeInfo[], next: readonly NodeInfo[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before.index !== after.index || before.turnNumber !== after.turnNumber) return false;
    const a = before.targetTurn;
    const b = after.targetTurn;
    if (a.entryId !== b.entryId || a.userMessage !== b.userMessage) return false;
    if (a.scrollTop !== b.scrollTop || a.toolCount !== b.toolCount) return false;
    if (a.finalAssistant?.entryId !== b.finalAssistant?.entryId) return false;
    if (a.finalAssistant?.blocks !== b.finalAssistant?.blocks) return false;
    if (a.finalAssistant?.element !== b.finalAssistant?.element) return false;
    if (a.finalAssistant?.streaming !== b.finalAssistant?.streaming) return false;
  }
  return true;
}

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
    /** 标题定位用「块下标 + 块内下标」，与逐块渲染的正文一致。 */
    headingBlockIndex?: number;
    headingIndex?: number;
  } | null>(null);

  const [visible, setVisible] = useState(false);
  const [minimapHovered, setMinimapHovered] = useState(false);
  /**
   * 锁定时悬停不再展开（`showPreview` 直接返回），所以另留一个显式入口：
   * 点一下胶囊把浮层钉住。锁定解除时一起收掉。
   */
  const [previewPinned, setPreviewPinned] = useState(false);
  /** 指针是否还在胶囊/浮层上：搜索框失焦时要靠它决定该不该收起。 */
  const hoveringRef = useRef(false);
  const [locked, setLocked] = useState(() => loadMinimapPreviewLocked());
  /** 浮层此刻是否展开：悬停打开的那一份，或锁定后点胶囊钉住的那一份。 */
  const previewOpen = minimapHovered || previewPinned;
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
  // 「这段回答有没有标题」的结果按正文缓存：滚动重测会反复问同一批回答。
  const [headingScanCache] = useState(() => new Map<string, boolean>());


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
    // 上一分支的待定位目标在新分支上永远不会出现，留着只会等一个不存在的条目。
    pendingNavigationRef.current = null;
    setRemoteOutline(null);
    // 旧会话的正文不会被再问到，缓存跟着会话/分支一起清掉。
    headingScanCache.clear();
  }, [headingScanCache, sessionId, leafId]);

  // 打开大纲且存在未加载历史时，按需向服务端拉取全分支轻量目录（不触发主对话翻页）。
  useEffect(() => {
    if (!previewOpen || !sessionId || turnsBefore <= 0) {
      // 历史翻完了（turnsBefore 归零）或预览已关闭：被取消的请求不会自己收尾，
      // 这里清掉加载态，否则面板会一直显示「正在读取完整大纲」。
      setOutlineLoading(false);
      return;
    }
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
  }, [leafId, outlineRequestKey, previewOpen, remoteOutline?.key, sessionId, turnsBefore]);

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
        const answer = cachedAssistantAnswer(message);
        // 纯图片答复返回空正文（而不是 null）：它是回答，只是没有文字标题。
        if (answer !== null) {
          // 1-A：每轮只保留最后一条最终回答，过滤中途过程回复。
          currentTurn.finalAssistant = {
            markdown: answer.markdown,
            blocks: answer.blocks,
            entryId: entryIdsRef.current[messageIndex],
            element,
            // 最后一条并带流式正文时就是正在输出的回复。
            ...(streamingMessage && messageIndex === allMessages.length - 1 ? { streaming: true } : {}),
          };
        }
      }

      const nextNodes = createTurnNodes(turns, turnsBeforeRef.current);
      // 位置和内容都没变时不必换新数组：`allNodes` 一变，整份预览就重渲染一遍。
      const changed = !sameTurnNodes(allNodesRef.current, nextNodes);
      allNodesRef.current = nextNodes;
      if (changed) setAllNodes(nextNodes);
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
            const headingRoot = findRenderedHeadingRoot(scrollEl, pendingNode.targetTurn.finalAssistant);
            const headingBlock = headingRoot && pendingNavigation.headingBlockIndex !== undefined
              ? headingRoot.querySelector<HTMLElement>(`[data-answer-block="${pendingNavigation.headingBlockIndex}"]`)
              : null;
            const heading = (
              pendingNavigation.headingIndex === undefined
                ? null
                : answerHeadingElements(headingBlock ?? headingRoot)[pendingNavigation.headingIndex]
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

  const scrollToHeading = useCallback((node: NodeInfo, headingBlockIndex: number, headingIndex: number) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const answerElement = findRenderedHeadingRoot(scrollEl, node.targetTurn.finalAssistant);
    if (!answerElement) {
      pendingNavigationRef.current = {
        nodeIndex: node.index,
        target: "heading",
        headingBlockIndex,
        headingIndex,
      };
      onRevealHistory(node.targetTurn.entryId);
      return;
    }
    // 正文按块渲染，每块各自带 data-answer-block：先定位块，再取块内第几个标题。
    const blockElement = answerElement.querySelector<HTMLElement>(`[data-answer-block="${headingBlockIndex}"]`);
    const heading = (blockElement ? answerHeadingElements(blockElement) : answerHeadingElements(answerElement))[headingIndex];
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
      // 加载期间切了会话或分支：这次的结果属于旧分支，展开新分支的窗口会跳到错的条目。
      // `jumpTargetRef` 在会话/分支变化时被清空，这里用它判断这次跳转是否还是当前目标。
      if (jumpTargetRef.current !== turn.entryId) {
        // 只清掉自己写进去的那一份：旧请求还没结束时用户可能已经开始了新跳转，
        // 无条件清空会把新跳转的待定位目标一起抹掉，它就永远不会滚过去。
        if (pendingNavigationRef.current?.entryId === turn.entryId) pendingNavigationRef.current = null;
        return;
      }
      if (loaded) {
        onRevealHistory(turn.entryId);
        measureNodes();
      } else {
        pendingNavigationRef.current = null;
        // 真的没找到才提示，不弹无意义的错误。
        setRevealFailed(true);
      }
    } finally {
      // 已经被新的跳转接管时，别清掉它的加载态。
      if (jumpTargetRef.current === turn.entryId) {
        jumpTargetRef.current = null;
        setLoadingEntryId(null);
      }
    }
  }, [loadingEntryId, measureNodes, onLoadUntilEntry, onNavigate, onRevealHistory, scrollContainer]);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const schedulePreviewHide = useCallback(() => {
    // 搜索框聚焦、浮层被钉住时都不自动收起；定时器到点时再确认一次指针已经离开。
    if (searchFocusedRef.current || previewPinned) return;
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      if (!searchFocusedRef.current && !hoveringRef.current) setMinimapHovered(false);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide, previewPinned]);

  const showPreview = useCallback(() => {
    // 锁定的语义就是这个（#1128）：悬停不展开预览，免得划过大纲时被挡住。
    if (locked) return;
    setRevealFailed(false);
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide, locked]);

  const enterPreview = useCallback(() => {
    hoveringRef.current = true;
    showPreview();
  }, [showPreview]);

  const leavePreview = useCallback(() => {
    hoveringRef.current = false;
    schedulePreviewHide();
  }, [schedulePreviewHide]);

  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    saveMinimapPreviewLocked(next);
    cancelPreviewHide();
    // 上锁收起悬停打开的那一份；解锁收起钉住的那一份，两种状态互不残留。
    setMinimapHovered(false);
    setPreviewPinned(false);
  }, [cancelPreviewHide, locked]);

  /** 锁定时的显式入口：点胶囊把浮层钉住/放开。 */
  const togglePreviewPinned = useCallback(() => {
    if (!locked) return;
    setRevealFailed(false);
    cancelPreviewHide();
    setPreviewPinned((current) => !current);
  }, [cancelPreviewHide, locked]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  // 刚打开大纲时把当前所在轮滚进可视区，方便直接看到上下文位置。
  useEffect(() => {
    if (!previewOpen || activeIndex === null || searchQuery.trim()) return;
    const targetItem = previewItemRefs.current.get(activeIndex);
    if (!targetItem) return;
    targetItem.scrollIntoView({ block: "nearest" });
  }, [activeIndex, previewOpen, searchQuery]);

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

  // 判断“这一轮有没有标题”要扫描整段最终回答。预览会在滚动切换当前轮时重渲染，
  // 所以按 allNodes 一次算好，别在渲染循环里对每一轮重扫 Markdown；正文没变的
  // 回答直接取缓存（滚动重测每次都会新建 allNodes，内容却没变）。
  const nodesWithHeadings = useMemo(() => {
    const indexes = new Set<number>();
    for (const node of allNodes) {
      const finalAssistant = node.targetTurn.finalAssistant;
      // 流式正文每帧都是新内容，进缓存只会占位并把它挤掉，直接扫这一份。
      // 逐块判断：预览也按块渲染，拼接后才出现的标题不该让折叠箭头出现。
      const hasHeadings = finalAssistant
        ? finalAssistant.blocks.some((block) => (
          finalAssistant.streaming
            ? hasOutlineHeadings(block.text)
            : cachedHasOutlineHeadings(headingScanCache, block.text)
        ))
        : false;
      if (hasHeadings) indexes.add(node.index);
    }
    return indexes;
  }, [allNodes, headingScanCache]);

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
      data-open={previewOpen ? "true" : undefined}
    >
      <div
        className={styles.pill}
        title={locked ? t("chatMinimap.pinPreview") : undefined}
        onClick={togglePreviewPinned}
        onMouseEnter={enterPreview}
        onMouseLeave={leavePreview}
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

      {previewOpen && totalTurnCount > 0 && (
        <div
          ref={previewBoxRef}
          className={styles.preview}
          data-minimap-preview-box=""
          data-minimap-preview-pinned={previewPinned ? "" : undefined}
          onMouseEnter={enterPreview}
          onMouseLeave={leavePreview}
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
                onBlur={() => {
                  searchFocusedRef.current = false;
                  // 失焦后不再挡住收起：指针已经离开就交给正常的延迟收起。
                  if (!hoveringRef.current) schedulePreviewHide();
                }}
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
              const hasHeadings = nodesWithHeadings.has(node.index);
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
                        blocks={finalAssistant.blocks}
                        onHeadingClick={canLocateAnswerHeadings(finalAssistant)
                          ? (blockIndex, headingIndex) => scrollToHeading(node, blockIndex, headingIndex)
                          : undefined}
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
