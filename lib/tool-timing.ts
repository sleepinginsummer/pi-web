/** 工具卡片的展示计时；与 SDK 的执行耗时分开保存，避免把生成参数或排队时间混入 SDK 用量。 */
export interface ToolTimingInfo {
  startedAt: number;
  durationMs?: number;
}

export function validToolTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formatToolDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes < 60 ? `${minutes}m ${whole % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${whole % 60}s`;
}

export function formatToolStartedAt(value: number | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}
