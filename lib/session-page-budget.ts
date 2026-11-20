/**
 * 会话分页的原始记录预算。
 *
 * `tail` 只数可见消息（user / assistant / compaction），而会话文件里还夹着大量
 * 不占 tail 的记录：工具结果、`shadow-mind-event`、`plan-mode-state` 等。一条分支
 * 的尾部可能连续几百条都是这类记录，如果只用「原始记录条数」当上限，一页就会
 * 在还没碰到任何消息时就停下，首屏看起来是空的。
 *
 * 所以预算分三层：
 * - `softRecords`：正常页大小。凑到可见消息之前允许带上这些过程记录；只要页里
 *   已经有消息，到点就收尾，工具输出不会无限挤进来。
 * - `hardRecords` / `maxBytes`：软上限到点却一条可见消息都没有时（尾部连续的非
 *   消息记录），继续向前找，但最多走到这里，避免病态文件把整条分支读进响应。
 *   越过软上限后凑到 `minVisibleAfterOverflow` 条才算合格，否则又是一条两条的
 *   碎片页。
 *
 * 内存路径（运行中的 wrapper）与磁盘索引路径必须共用这一份规则，否则一边修好了
 * 另一边仍然截断。
 */
export interface SessionPageBudget {
  softRecords: number;
  hardRecords: number;
  maxBytes: number;
  minVisibleAfterOverflow: number;
}

const MIN_SOFT_RECORDS = 200;
const SOFT_RECORD_FACTOR = 6;
const HARD_RECORD_FACTOR = 40;
const MIN_HARD_RECORDS = 2000;
/** 单页最多读多少字节的原始记录（只有磁盘索引路径能按索引元数据算出，内存路径传 0）。 */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MIN_VISIBLE_AFTER_OVERFLOW = 10;

export function sessionPageBudget(tail: number): SessionPageBudget {
  return {
    softRecords: Math.max(MIN_SOFT_RECORDS, tail * SOFT_RECORD_FACTOR),
    hardRecords: Math.max(MIN_HARD_RECORDS, tail * HARD_RECORD_FACTOR),
    maxBytes: MAX_PAGE_BYTES,
    minVisibleAfterOverflow: Math.min(tail, MIN_VISIBLE_AFTER_OVERFLOW),
  };
}

export interface PageWalkerCounts {
  records: number;
  visible: number;
  bytes: number;
  /** 软上限到点却还没有可见消息，已经切到「向前补齐」模式。 */
  overflowed: boolean;
}

/**
 * 沿分支遍历时逐条调用：`accept()` 返回 `true` 表示这一页到此为止。
 * 计数与判定放在同一处，两条读取路径不会各写一份规则。
 */
export function createPageWalker(tail: number): {
  accept: (countsAsVisible: boolean, recordBytes?: number) => boolean;
  counts: () => PageWalkerCounts;
} {
  const budget = sessionPageBudget(tail);
  const state: PageWalkerCounts = { records: 0, visible: 0, bytes: 0, overflowed: false };
  return {
    accept(countsAsVisible: boolean, recordBytes = 0): boolean {
      state.records += 1;
      if (countsAsVisible) state.visible += 1;
      if (recordBytes > 0) state.bytes += recordBytes;
      if (state.visible >= tail) return true;
      if (state.records >= budget.hardRecords || state.bytes >= budget.maxBytes) return true;
      if (!state.overflowed) {
        if (state.records >= budget.softRecords) {
          // 页里已经凑到消息：按预算收尾。一条都没有：尾部是连续的过程记录，继续向前。
          if (state.visible > 0) return true;
          state.overflowed = true;
        }
        return false;
      }
      return state.visible >= budget.minVisibleAfterOverflow;
    },
    counts: () => ({ ...state }),
  };
}
