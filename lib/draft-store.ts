import type { UserMessage } from "./types";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /** 输入框中以 TXT 条目展示的超长粘贴文本。 */
  textAttachment?: string;
}

const drafts = new Map<string, ChatDraft>();

/**
 * 已从服务端取回、但聊天区还没重新读成功的那份草稿：切走再切回来（ChatWindow 重新挂载）时
 * 页面状态会重置，而这个标记留在模块里，错误页因此还能提示「不要刷新」并给应用内重试。
 */
const pendingRestores = new Set<string>();

const restoreListeners = new Map<string, Set<() => void>>();

export function markDraftRestorePending(key: string): void {
  pendingRestores.add(key);
  // 取回请求可能在切走再切回之后才返回：当前挂载的会话也要立刻进入「已取回」状态，
  // 否则错误页还停在「请刷新」，而刷新正好丢掉刚取回的正文。
  for (const listener of restoreListeners.get(key) ?? []) listener();
}

export function subscribeDraftRestore(key: string, listener: () => void): () => void {
  let listeners = restoreListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    restoreListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) restoreListeners.delete(key);
  };
}

export function clearDraftRestorePending(key: string): void {
  pendingRestores.delete(key);
}

export function hasPendingDraftRestore(key: string): boolean {
  return pendingRestores.has(key);
}

/**
 * 取回结果迟到时（请求还没返回，用户已经切走再切回）通知这个会话当前挂载的输入框。
 * 旧实例卸载后只把正文写进草稿存储，界面交给新实例，否则已取回的消息只能等到下次挂载。
 */
const recallListeners = new Map<string, Set<(draft: ChatDraft) => void>>();
// 取回投递的版本号：输入框用它判断「读完初始草稿之后」有没有过一次投递。不能用恢复标记，
// 那个标记会在上下文加载成功后清掉，而这时输入框可能还没订阅上。
const recallRevisions = new Map<string, number>();

export function recallRevision(key: string): number {
  return recallRevisions.get(key) ?? 0;
}

export function notifyRecalledDraft(key: string, draft: ChatDraft): void {
  recallRevisions.set(key, (recallRevisions.get(key) ?? 0) + 1);
  for (const listener of recallListeners.get(key) ?? []) listener(cloneDraft(draft));
}

export function subscribeRecalledDraft(key: string, listener: (draft: ChatDraft) => void): () => void {
  let listeners = recallListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    recallListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) recallListeners.delete(key);
  };
}

/** Where a fresh composer's draft waits once the page leaves it; the next fresh composer in that cwd takes it back. */
export function parkedNewSessionDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    textAttachment: draft.textAttachment,
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && !draft.textAttachment;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    // 草稿空了（发出去了或用户清掉）就没有需要保护的内容了。
    pendingRestores.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  pendingRestores.delete(key);
}

/** 将用户消息转换为新会话输入草稿；仅保留输入框支持的文本与 base64 图片。 */
export function createDraftFromUserMessage(message: UserMessage): ChatDraft {
  if (typeof message.content === "string") return { value: message.content, images: [] };

  return {
    value: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    images: message.content.flatMap((block) => (
      block.type === "image"
      && block.source.type === "base64"
      && block.source.data
      && block.source.media_type
        ? [{ data: block.source.data, mimeType: block.source.media_type }]
        : []
    )),
  };
}
