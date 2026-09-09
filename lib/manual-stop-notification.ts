const manuallyStoppedSessionIds = new Set<string>();

/** 标记当前会话由用户主动停止，完成边界只消费一次该标记。 */
export function markManualStopNotificationSuppressed(sessionId: string): void {
  manuallyStoppedSessionIds.add(sessionId);
}

/** 停止请求失败或下一轮开始时，恢复该会话的正常完成通知。 */
export function clearManualStopNotificationSuppression(sessionId: string): void {
  manuallyStoppedSessionIds.delete(sessionId);
}

/** 当前会话只读取标记，保留给稍后到达的后台完成轮询继续判断。 */
export function isManualStopNotificationSuppressed(sessionId: string): boolean {
  return manuallyStoppedSessionIds.has(sessionId);
}

/** 后台完成轮询消费主动停止标记，避免同一会话后续继续被抑制。 */
export function consumeManualStopNotificationSuppression(sessionId: string): boolean {
  const suppressed = manuallyStoppedSessionIds.has(sessionId);
  manuallyStoppedSessionIds.delete(sessionId);
  return suppressed;
}
