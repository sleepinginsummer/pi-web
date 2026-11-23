import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";
import type { SessionEntry } from "./types";

/**
 * 流式按行检查会话文件是否引用目标路径：
 * 先用文件名做无假阴性的字符串粗筛，命中才 JSON.parse 单行并交给核心安全校验，
 * 避免预览外部文件时把几百 MB 的历史会话全量解析进内存。
 */
async function scanSessionFileForReference(
  sessionPath: string,
  filePath: string,
  matcher: (targetPath: string, entries: SessionEntry[]) => boolean,
): Promise<boolean> {
  const name = basename(filePath);
  const encodedName = encodeURIComponent(name);
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      if (name && !line.includes(name) && !line.includes(encodedName) && !line.includes("\\u")) {
        continue;
      }
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }
      if (matcher(filePath, [entry])) return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function checkSessionReference(
  filePath: string,
  sessionId: string | null,
  matcher: (targetPath: string, entries: SessionEntry[]) => boolean,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const live = getRpcSession(sessionId);
    if (live?.isAlive()) {
      return matcher(filePath, live.inner.sessionManager.getEntries() as unknown as SessionEntry[]);
    }
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return await scanSessionFileForReference(sessionPath, filePath, matcher);
  } catch {
    return false;
  }
}

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return checkSessionReference(filePath, sessionId, isFilePathReferencedByEntries);
}

export async function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return checkSessionReference(filePath, sessionId, isBashOutputPathReferencedByEntries);
}
