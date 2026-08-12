// 批量标题生成：为回收站与全部未删除会话补生成标题（已有标题/无内容的会话跳过）。
// 串行执行避免并发打爆 provider；任务状态存 globalThis（hot-reload 安全），支持查询与取消。
import { basename, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { generateTitleForSessionFile } from "./session-file-title";
import { getTrashDir, listTrashedSessions } from "./trash";

export interface BulkTitleError {
  /** 会话文件名（含回收站时间戳前缀或原始名） */
  name: string;
  error: string;
}

export interface BulkTitleProgress {
  status: "idle" | "running" | "done" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** 正在处理的会话文件名 */
  current: string | null;
  /** 最多保留的错误明细 */
  errors: BulkTitleError[];
  startedAt: number | null;
  finishedAt: number | null;
}

const MAX_RETAINED_ERRORS = 20;

interface BulkTitleState {
  cancelled: boolean;
  progress: BulkTitleProgress;
}

declare global {
  var __piBulkTitle: BulkTitleState | undefined;
}

function idleProgress(): BulkTitleProgress {
  return {
    status: "idle",
    total: 0,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    current: null,
    errors: [],
    startedAt: null,
    finishedAt: null,
  };
}

function getState(): BulkTitleState {
  if (!globalThis.__piBulkTitle) {
    globalThis.__piBulkTitle = { cancelled: false, progress: idleProgress() };
  }
  return globalThis.__piBulkTitle;
}

export function getBulkTitleProgress(): BulkTitleProgress {
  return getState().progress;
}

/** 请求停止批量任务（当前文件处理完后停止）。 */
export function cancelBulkTitleGeneration(): void {
  getState().cancelled = true;
}

async function runBulkTitleJob(state: BulkTitleState): Promise<void> {
  // 先同步进入 running（调用方 POST 响应即可拿到运行态），文件列表随后补齐
  Object.assign(state.progress, {
    status: "running",
    total: 0,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    current: null,
    errors: [],
    startedAt: Date.now(),
    finishedAt: null,
  });
  // 任务开始时快照文件列表：回收站 + 未删除会话（各去重一次）
  const files: string[] = [];
  const seen = new Set<string>();
  for (const s of listTrashedSessions()) {
    const p = join(getTrashDir(), s.fileName);
    if (!seen.has(p)) {
      seen.add(p);
      files.push(p);
    }
  }
  const piSessions = await SessionManager.listAll();
  for (const s of piSessions) {
    if (!seen.has(s.path)) {
      seen.add(s.path);
      files.push(s.path);
    }
  }

  // 原地更新而非替换对象：startBulkTitleGeneration 已把引用返回给调用方，
  // 替换会导致外部持有的 progress 永远停留在旧状态
  Object.assign(state.progress, {
    total: files.length,
  });

  for (const file of files) {
    if (state.cancelled) break;
    state.progress.current = basename(file);
    try {
      const generated = await generateTitleForSessionFile(file);
      if (generated) state.progress.succeeded += 1;
      else state.progress.skipped += 1;
    } catch (error) {
      state.progress.failed += 1;
      if (state.progress.errors.length < MAX_RETAINED_ERRORS) {
        state.progress.errors.push({
          name: basename(file),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    state.progress.processed += 1;
  }

  state.progress.status = state.cancelled ? "cancelled" : "done";
  state.progress.current = null;
  state.progress.finishedAt = Date.now();
}

/** 启动批量标题生成（已在运行则直接返回当前进度）；执行在后台进行，不阻塞调用方。 */
export function startBulkTitleGeneration(): BulkTitleProgress {
  const state = getState();
  if (state.progress.status === "running") return state.progress;
  state.cancelled = false;
  void runBulkTitleJob(state).catch((error) => {
    // 兜底：任务级异常（如目录不可读）也落到 done，避免状态永远挂在 running
    console.error("[pi-web] bulk title generation failed:", error instanceof Error ? error.message : String(error));
    state.progress.status = "done";
    state.progress.current = null;
    state.progress.finishedAt = Date.now();
  });
  return state.progress;
}
