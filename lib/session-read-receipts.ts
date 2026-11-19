import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";

const MAX_RECEIPTS = 1_000;
const pathForReceipts = () => join(getAgentDir(), "pi-web-session-read-receipts.json");
let cached: { path: string; version: string; data: Readonly<Record<string, number>> } | undefined;

export function readSessionReceipts(path = pathForReceipts()): Readonly<Record<string, number>> {
  try {
    const stat = statSync(path, { bigint: true });
    const version = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    if (cached?.path === path && cached.version === version) return cached.data;
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("无效的会话已读记录");
    const data = Object.fromEntries(Object.entries(json).filter(([, time]) => typeof time === "number" && Number.isSafeInteger(time) && time >= 0));
    cached = { path, version, data };
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[pi-web] 读取会话已读记录失败", error);
    return {};
  }
}

export async function recordSessionRead(sessionId: string, path = pathForReceipts()): Promise<number> {
  return withPrivateFileLock(path, () => {
    const current = readSessionReceipts(path);
    const previous = Object.hasOwn(current, sessionId) ? current[sessionId] : 0;
    const readAt = Math.max(Date.now(), previous);
    const entries = Object.entries({ ...current, [sessionId]: readAt })
      .sort(([, left], [, right]) => right - left)
      .slice(0, MAX_RECEIPTS);
    writePrivateFileAtomicSync(path, JSON.stringify(Object.fromEntries(entries)) + "\n");
    return readAt;
  });
}
