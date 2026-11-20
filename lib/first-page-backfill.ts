import type { SessionContextSnapshot } from "./session-load-client";

/**
 * 首屏补页：一页只数可见消息，分支尾部若是一长串过程记录（`shadow-mind-event`、
 * `plan-mode-state`…），服务端可能整页都没有消息（见 `lib/session-page-budget.ts`）。
 * 这时继续向前补几页，直到拿到消息或翻到分支起点。
 *
 * 翻页决策只看**服务端返回的页**：游标、有没有消息、entryId 全部来自响应。客户端状态
 * （ref、state、上一帧的分页快照）在同一个异步续体里都可能是旧的，读到它会让补页一次
 * 都不发生，或者拿着上一个会话的内容误判「已经有消息了」。
 */
export interface BackfillPageCursor {
  oldestEntryId: string | null;
  hasMore: boolean;
  entryIds: readonly string[];
  /** 这一页里的可见消息；只用来判断「翻到了没有」。 */
  messages: readonly unknown[];
}

export interface BackfillPage {
  snapshot: BackfillPageCursor;
  leafId: string | null;
}

export interface FirstPageBackfillOptions<Page extends BackfillPage> {
  /** 首屏那一页（已经提交进界面、元数据也以它为准的那一份）；为空才需要补页。 */
  first: BackfillPageCursor;
  /** 读取更早一页；返回 null 表示放弃（缺失、失败或取消）。 */
  readOlder: (before: string) => Promise<Page | null>;
  /** 提交合并后的视图；返回 false 表示放弃（会话已切换等）。 */
  commit: (page: Page) => boolean;
  limit?: number;
}

/** 默认最多补三页：翻不到就保留「加载更早消息」入口，不做无上限的自动翻页。 */
export const FIRST_PAGE_BACKFILL_LIMIT = 3;

/** 补页并返回实际补了几页（0 表示首屏本来就有内容，或没有更早的页）。 */
export async function backfillFirstPage<Page extends BackfillPage>(
  options: FirstPageBackfillOptions<Page>,
): Promise<number> {
  const limit = options.limit ?? FIRST_PAGE_BACKFILL_LIMIT;
  let cursor = { oldestEntryId: options.first.oldestEntryId, hasMore: options.first.hasMore };
  // 已加载的消息与 entryId 都从首屏响应推出来，累计到本地，不读客户端状态。
  let visible = options.first.messages.length;
  const seen = new Set(options.first.entryIds);
  let pages = 0;
  while (pages < limit) {
    if (visible > 0 || !cursor.hasMore || !cursor.oldestEntryId) break;
    const before = cursor.oldestEntryId;
    const page = await options.readOlder(before);
    if (!page) break;
    // 前一页重复：宁可停在当前页，也不把同一段历史插两遍。
    if (page.snapshot.entryIds.some((id) => seen.has(id))) break;
    if (!options.commit(page)) break;
    pages += 1;
    for (const id of page.snapshot.entryIds) seen.add(id);
    visible += page.snapshot.messages.length;
    const next = page.snapshot.oldestEntryId;
    // 游标必须真的往前走：服务端把同一页又给回来（或没给游标）时，继续翻只会拿同一段
    // 历史反复请求，停在当前页交给「加载更早消息」。
    if (!next || next === before) break;
    cursor = { oldestEntryId: next, hasMore: page.snapshot.hasMore };
  }
  return pages;
}

/**
 * 把更早一页拼到当前页前面。
 *
 * 元数据（model / thinkingLevel / version / totalActiveMs / shadowMindEnabled）必须保留
 * **首屏那一页**的值：更早的页是从 `before` 往上算出来的设置，会话尾部改过模型或思考
 * 强度时，用它会把手上的选择改回去。只从旧页取消息、entryId 和游标。
 */
export function mergeOlderPage(
  newest: SessionContextSnapshot,
  older: SessionContextSnapshot,
): SessionContextSnapshot {
  return {
    ...newest,
    messages: [...older.messages, ...newest.messages],
    entryIds: [...older.entryIds, ...newest.entryIds],
    oldestEntryId: older.oldestEntryId,
    hasMore: older.hasMore,
    turnsBefore: older.turnsBefore,
  };
}
