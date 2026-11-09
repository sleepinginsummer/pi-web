export interface SessionCompletionSummary {
  sessionId: string;
  title: string;
  preview: string;
}

/** 轮询每 2.5 秒带上全部条目，上限同时约束响应体积和内存。 */
const MAX_SUMMARIES = 32;

const globalState = globalThis as typeof globalThis & {
  __piSessionCompletionSummaries?: Map<string, SessionCompletionSummary>;
};

function registry(): Map<string, SessionCompletionSummary> {
  globalState.__piSessionCompletionSummaries ??= new Map();
  return globalState.__piSessionCompletionSummaries;
}

/** 后台会话的完成通知只能从轮询得知内容，所以运行结束时把摘要留在服务端。 */
export function recordSessionCompletionSummary(summary: SessionCompletionSummary): void {
  const summaries = registry();
  summaries.delete(summary.sessionId);
  summaries.set(summary.sessionId, summary);
  for (const oldest of summaries.keys()) {
    if (summaries.size <= MAX_SUMMARIES) break;
    summaries.delete(oldest);
  }
}

/** 新一轮开始时清掉，避免这一轮异常结束后显示上一轮的回复。 */
export function forgetSessionCompletionSummary(sessionId: string): void {
  registry().delete(sessionId);
}

export function listSessionCompletionSummaries(): SessionCompletionSummary[] {
  return [...registry().values()];
}
