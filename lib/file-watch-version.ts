import type { Stats } from "node:fs";

/** 与文件监听的变更判定保持一致；不包含读取文件时会变化的访问时间。 */
export function getFileWatchVersion(stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
